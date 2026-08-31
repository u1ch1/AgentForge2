import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getProjectDir } from './projects'

/**
 * Запуск команд сборки и тестов внутри папки активного проекта.
 *
 * ВАЖНО: это выполнение произвольного кода — npm-скрипты проекта делают что
 * угодно. Запускается только то, что перечислено в planChecks(), и только в
 * папке проекта. Пользователь включает эту возможность осознанно.
 *
 * Вывод обрезается: полный лог сборки не влезет в контекст модели, а нужен из
 * него в основном хвост с ошибками.
 */

const DEFAULT_TIMEOUT = 5 * 60 * 1000
const HEAD_CHARS = 6_000
const TAIL_CHARS = 18_000

export interface CommandResult {
  label: string
  command: string
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export interface CheckStep {
  label: string
  command: string
  args: string[]
  /** Папка запуска. Пусто — корень проекта. */
  dir?: string
  /** true — падение шага не считается провалом проверки (например, тестов просто нет). */
  optional?: boolean
  timeoutMs?: number
}

/** Папки, внутрь которых искать проекты бессмысленно. */
const SKIP_SCAN = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', '.next',
  'coverage', '__pycache__', 'venv', '.venv', '.turbo', 'deploy', 'vendor',
])

const MANIFEST_FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'composer.json', 'manage.py']

/**
 * Где в проекте лежат манифесты.
 *
 * Раньше смотрели только в корень — и раскладка «backend/ + frontend/», которую
 * конвейер сам же и создаёт для крупных задач, проходила вообще без проверок:
 * «проверять нечем», статус unverified, гейт мимо. Теперь заглядываем и внутрь,
 * но неглубоко: манифест на третьем уровне вложенности — это уже пакет внутри
 * пакета, а не отдельная часть проекта.
 */
export function findManifestRoots(cwd?: string): string[] {
  const root = cwd ?? getProjectDir()
  const roots: string[] = []

  const hasManifest = (dir: string): boolean =>
    MANIFEST_FILES.some((f) => fs.existsSync(path.join(dir, f)))

  if (hasManifest(root)) roots.push(root)

  const scan = (dir: string, depth: number): void => {
    if (depth > 2 || roots.length >= 4) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_SCAN.has(e.name) || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (hasManifest(full)) {
        if (!roots.includes(full)) roots.push(full)
        // Внутрь найденного проекта не идём: его собственные подпакеты
        // соберутся его же сборкой.
        continue
      }
      scan(full, depth + 1)
    }
  }

  // В корне манифест есть — вложенные пакеты обычно часть той же сборки.
  if (roots.length === 0) scan(root, 1)
  return roots
}

function clamp(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text
  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(-TAIL_CHARS)
  const cut = text.length - HEAD_CHARS - TAIL_CHARS
  return `${head}\n\n… пропущено ${cut} символов …\n\n${tail}`
}

/** Убивает процесс вместе с потомками: npm запускает настоящую команду отдельным процессом. */
export function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

export function runCommand(step: CheckStep, cwd?: string): Promise<CommandResult> {
  const started = Date.now()
  const dir = step.dir ?? cwd ?? getProjectDir()
  const printable = `${step.command} ${step.args.join(' ')}`.trim()

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    // shell: true обязателен: начиная с Node 18.20/20.12 spawn отказывается
    // запускать .cmd-файлы (npm.cmd в том числе) без него.
    const proc = spawn(step.command, step.args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        label: step.label,
        command: printable,
        code,
        stdout: clamp(stdout),
        stderr: clamp(stderr),
        timedOut,
        durationMs: Date.now() - started,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(proc)
      finish(null)
    }, step.timeoutMs ?? DEFAULT_TIMEOUT)

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      // Держим в памяти ограниченный хвост даже для очень болтливых сборок.
      if (stdout.length > 400_000) stdout = stdout.slice(-200_000)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000)
    })

    proc.on('error', (e) => {
      stderr += `\n${e.message}`
      finish(null)
    })
    proc.on('close', (code) => finish(code))
  })
}

interface PackageJson {
  scripts?: Record<string, string>
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    const p = path.join(dir, 'package.json')
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as PackageJson
  } catch {
    return null
  }
}

/**
 * Определяет, чем проверять проект. Пустой список означает, что проверять
 * нечем — тогда вердикт выносится только по ревью кода.
 *
 * Обходит все найденные манифесты: у раскладки «backend + frontend» своя
 * сборка и свои тесты в каждой половине.
 */
export function planChecks(cwd?: string): CheckStep[] {
  const roots = findManifestRoots(cwd)
  const root = cwd ?? getProjectDir()
  const steps: CheckStep[] = []

  for (const dir of roots) {
    const rel = path.relative(root, dir).split(path.sep).join('/')
    // Имя папки в подписи нужно, чтобы в сводке было видно, где что упало.
    const prefix = rel ? `${rel}: ` : ''
    for (const step of planChecksIn(dir)) {
      steps.push({ ...step, label: prefix + step.label, dir })
    }
  }
  return steps
}

/** Шаги проверки для одной папки с манифестом. */
function planChecksIn(dir: string): CheckStep[] {
  const steps: CheckStep[] = []
  const pkg = readPackageJson(dir)

  if (pkg) {
    const scripts = pkg.scripts ?? {}
    const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'))
    steps.push({
      label: 'Установка зависимостей',
      command: 'npm',
      // ci строже и быстрее, но требует синхронного lock-файла; при его
      // отсутствии или рассинхроне остаётся install.
      args: hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'],
      timeoutMs: 8 * 60 * 1000,
    })

    if (scripts.typecheck) {
      steps.push({ label: 'Проверка типов', command: 'npm', args: ['run', 'typecheck'] })
    } else if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
      steps.push({ label: 'Проверка типов', command: 'npx', args: ['tsc', '--noEmit'] })
    }

    if (scripts.build) {
      steps.push({ label: 'Сборка', command: 'npm', args: ['run', 'build'] })
    }
    if (scripts.lint) {
      // Не блокирует приёмку: стиль и предупреждения — не повод переделывать
      // рабочий код, но воркер увидит их в сводке и может поправить попутно.
      steps.push({
        label: 'Линтер',
        command: 'npm',
        args: ['run', 'lint'],
        optional: true,
        timeoutMs: 2 * 60 * 1000,
      })
    }
    if (scripts.test) {
      // Тесты часто настроены в watch-режиме и никогда не завершаются сами —
      // поэтому короткий таймаут, а провал не блокирует приёмку.
      steps.push({
        label: 'Тесты',
        command: 'npm',
        args: ['test'],
        optional: true,
        timeoutMs: 3 * 60 * 1000,
      })
    }
    return steps
  }

  const hasRequirements = fs.existsSync(path.join(dir, 'requirements.txt'))
  const hasPyProject = fs.existsSync(path.join(dir, 'pyproject.toml'))
  const hasManagePy = fs.existsSync(path.join(dir, 'manage.py'))
  if (hasRequirements || hasPyProject || hasManagePy) {
    if (hasRequirements) {
      steps.push({
        label: 'Установка зависимостей',
        command: 'python',
        args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
        timeoutMs: 8 * 60 * 1000,
      })
    }
    steps.push({
      label: 'Проверка синтаксиса',
      command: 'python',
      args: ['-m', 'compileall', '-q', '.'],
    })
    // Только если ruff сам в requirements.txt — не навязываем зависимость,
    // которую воркер не выбирал.
    if (hasRequirements && /^ruff\b/m.test(fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf-8'))) {
      steps.push({
        label: 'Линтер',
        command: 'python',
        args: ['-m', 'ruff', 'check', '.'],
        optional: true,
        timeoutMs: 2 * 60 * 1000,
      })
    }
    if (fs.existsSync(path.join(dir, 'tests'))) {
      steps.push({
        label: 'Тесты',
        command: 'python',
        args: ['-m', 'pytest', '-q'],
        optional: true,
        timeoutMs: 3 * 60 * 1000,
      })
    }
    return steps
  }

  // PHP (Laravel и обычные проекты на composer). Синтаксической проверки всей
  // папки одной командой тут нет — composer install уже ловит большую часть
  // проблем на этапе автозагрузки; artisan test запускаем, только если он
  // реально есть (Laravel), иначе тестового раннера может не быть вовсе.
  if (fs.existsSync(path.join(dir, 'composer.json'))) {
    steps.push({
      label: 'Установка зависимостей',
      command: 'composer',
      args: ['install', '--no-interaction', '--no-progress'],
      timeoutMs: 8 * 60 * 1000,
    })
    if (fs.existsSync(path.join(dir, 'artisan'))) {
      steps.push({
        label: 'Тесты',
        command: 'php',
        args: ['artisan', 'test'],
        optional: true,
        timeoutMs: 3 * 60 * 1000,
      })
    }
  }

  return steps
}

export interface CheckReport {
  ran: boolean
  passed: boolean
  results: CommandResult[]
  /** Сжатая выжимка ошибок для промпта воркера. */
  summary: string
}

/** Прогон всех проверок по порядку. Останавливается на первом обязательном провале. */
export async function runChecks(cwd?: string): Promise<CheckReport> {
  const steps = planChecks(cwd)
  if (steps.length === 0) {
    return { ran: false, passed: false, results: [], summary: 'Проверять нечем: не найден package.json или requirements.txt.' }
  }

  const results: CommandResult[] = []
  for (const step of steps) {
    const res = await runCommand(step, cwd)
    results.push(res)
    const failed = res.timedOut || res.code !== 0
    if (failed && !step.optional) {
      return {
        ran: true,
        passed: false,
        results,
        summary: summarize(results),
      }
    }
  }

  return { ran: true, passed: true, results, summary: summarize(results) }
}

function summarize(results: CommandResult[]): string {
  const lines: string[] = []
  for (const r of results) {
    const status = r.timedOut ? 'ТАЙМАУТ' : r.code === 0 ? 'OK' : `КОД ${r.code}`
    lines.push(`[${status}] ${r.label}: ${r.command} (${Math.round(r.durationMs / 1000)} с)`)
  }
  const broken = results.find((r) => r.timedOut || r.code !== 0)
  if (broken) {
    // Ошибки сборки инструменты пишут то в stderr, то в stdout — берём оба.
    const detail = [broken.stderr, broken.stdout].filter(Boolean).join('\n').trim()
    lines.push('', `Вывод шага «${broken.label}»:`, detail || '(пусто)')
  }
  return lines.join('\n')
}
