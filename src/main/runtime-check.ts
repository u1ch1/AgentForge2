import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { getProjectDir } from './projects'
import { findManifestRoots, killTree } from './command-runner'
import { auditLayout, describeLayout, type LayoutReport } from './layout-audit'

/**
 * «Подними и постучись» — проверка работающего приложения, а не собранного.
 *
 * Сборка и тесты отвечают на вопрос «компилируется ли». На вопрос «работает ли»
 * они не отвечают вообще: приёмка в command-runner.ts умеет одну форму — команда
 * завершилась, взяли код возврата. Сервер не завершается никогда, поэтому
 * целый класс дефектов проходил гейт насквозь. На живом заказе так прошли:
 * отсутствие команды запуска, HTML со стек-трейсом вместо JSON и протекающие
 * наружу сообщения JS-исключений.
 *
 * Браузер для этого не нужно приносить с собой: Electron — это Chromium,
 * страница открывается в скрытом BrowserWindow, ошибки консоли собираются
 * оттуда же. Никаких новых зависимостей.
 */

/** Ждём готовности сервера столько: холодный старт бывает медленным. */
const READY_TIMEOUT = 25_000
const PROBE_TIMEOUT = 8_000
const PAGE_TIMEOUT = 12_000
/** Больше — и проверка начнёт занимать больше времени, чем сама работа воркеров. */
const MAX_ROUTES = 8

export interface RuntimeFinding {
  /** hard блокирует приёмку наравне с падением сборки, soft идёт только в отчёт. */
  severity: 'hard' | 'soft'
  text: string
}

/** Что видно на странице — из этого Тестер составляет сценарий. */
export interface PageSnapshot {
  url: string
  title: string
  /** Элементы, с которыми можно взаимодействовать, с готовыми селекторами. */
  elements: {
    selector: string
    tag: string
    type?: string
    text?: string
    placeholder?: string
    disabled?: boolean
  }[]
  /** Начало разметки — на случай, если нужного элемента нет в списке. */
  html: string
}

/**
 * Шаг пользовательского сценария.
 *
 * Набор намеренно крошечный: каждый шаг превращается в короткий и предсказуемый
 * фрагмент кода на странице. Модель присылает данные, а не код — выполнять
 * текст от модели в окне нельзя ни при каких условиях.
 */
export type ScenarioStep =
  | { action: 'fill'; selector: string; value: string }
  | { action: 'click'; selector: string }
  | { action: 'waitFor'; selector: string; timeoutMs?: number }
  | { action: 'expectText'; value: string }
  | { action: 'expectChecked'; selector: string }
  | { action: 'expectEnabled'; selector: string }

/** Как сценарий отработал: для журнала и для задания воркеру. */
export interface ScenarioOutcome {
  step: ScenarioStep
  ok: boolean
  detail: string
}

/**
 * Промежуточные события проверки — единственная цель существования:
 * дать вызывающей стороне показать прогресс в реальном времени, пока сам
 * прогон идёт (он может занимать десятки секунд). Механика ничего не решает
 * по этим событиям — они только для наблюдения.
 */
export type RuntimeProgressEvent =
  | { kind: 'starting'; command: string }
  | { kind: 'up'; url: string }
  | { kind: 'opening'; url: string }
  | { kind: 'step'; index: number; total: number; description: string; ok: boolean | null }
  | { kind: 'screenshot'; path: string }
  | { kind: 'design_start' }
  | { kind: 'design_done'; wrote: boolean }

export interface RuntimeOptions {
  /**
   * Сочиняет сценарий по снимку страницы. Вызывается, пока сервер поднят и
   * страница открыта. Модель дёргает оркестратор — здесь только механика.
   */
  scenario?: (page: PageSnapshot) => Promise<ScenarioStep[]>
  /**
   * Правит оформление по замечаниям измерителя. Вызывается, пока приложение
   * поднято: файлы переписываются на диске, страница перечитывается, мерки
   * снимаются заново — так виден результат правки, а не намерение.
   * Возвращает true, если что-то действительно записал.
   */
  design?: (page: PageSnapshot, report: LayoutReport) => Promise<boolean>
  /** Куда сохранить снимок готовой страницы. Пусто — не снимать. */
  screenshotPath?: string
  /** Живой прогресс проверки — необязателен, механику не меняет. */
  onProgress?: (event: RuntimeProgressEvent) => void
}

export interface RuntimeReport {
  /** false — проект не похож на веб-приложение, проверять нечего. */
  ran: boolean
  ok: boolean
  findings: RuntimeFinding[]
  /** Проигранный пользовательский сценарий, если до него дошло дело. */
  scenario: ScenarioOutcome[]
  /** Мерки вёрстки до и после правки дизайнера. */
  layout: { before: LayoutReport; after: LayoutReport | null } | null
  /** Путь к снимку готовой страницы, если его удалось сделать. */
  screenshot: string | null
  /** Выжимка для промпта воркера и для журнала. */
  summary: string
}

/**
 * Поднятый на проверку процесс.
 *
 * Обычный путь убивает его в finally, но при закрытии приложения посреди
 * проверки finally не выполнится вовсе — и сервер останется жить на машине
 * пользователя, занимая порт. Поэтому ссылка хранится снаружи.
 */
let current: ChildProcess | null = null

/** Вызывается при выходе из приложения: не оставлять за собой чужих процессов. */
export function stopRuntimeCheck(): void {
  if (current) killTree(current)
  current = null
}

/**
 * Убивает дерево процессов и дожидается, пока taskkill отработает.
 *
 * Ждать обязательно. Сервер запускается через оболочку, поэтому дерево такое:
 * cmd → npm → node. Само по себе завершение cmd потомков не забирает, а
 * taskkill — отдельный процесс: не дождавшись его, мы возвращаем управление,
 * приложение закрывается, и node с сервером остаётся жить, занимая порт.
 * На прогонах проверок это стабильно оставляло висеть по два node.exe.
 */
function killTreeAndWait(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.pid === undefined) return resolve()
    if (process.platform !== 'win32') {
      killTree(proc)
      return resolve()
    }
    const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('close', () => resolve())
    killer.on('error', () => resolve())
    setTimeout(resolve, 5000)
  })
}

async function terminate(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await killTreeAndWait(proc)
  await Promise.race([
    new Promise<void>((resolve) => proc.once('close', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ])
}

const NOT_APPLICABLE: RuntimeReport = {
  ran: false,
  ok: true,
  findings: [],
  scenario: [],
  layout: null,
  screenshot: null,
  summary: 'Проект не похож на веб-приложение — проверять в браузере нечего.',
}

interface PackageJson {
  main?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
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

const WEB_DEPS = [
  'express', 'fastify', 'koa', '@hapi/hapi', 'next', 'nuxt', 'vite',
  'react-scripts', 'http-server', 'serve', '@nestjs/core',
]
const WEB_PY = ['flask', 'fastapi', 'django', 'uvicorn', 'gunicorn', 'aiohttp']

/** Стоит ли вообще поднимать проект: у библиотеки и утилиты нет интерфейса. */
function looksLikeWebApp(dir: string, pkg: PackageJson | null): boolean {
  if (fs.existsSync(path.join(dir, 'public', 'index.html'))) return true
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (WEB_DEPS.some((d) => d in deps)) return true
  }
  for (const manifest of ['requirements.txt', 'pyproject.toml']) {
    const p = path.join(dir, manifest)
    if (!fs.existsSync(p)) continue
    try {
      const text = fs.readFileSync(p, 'utf-8').toLowerCase()
      if (WEB_PY.some((d) => text.includes(d))) return true
    } catch {
      /* нечитаемый манифест — просто не признак */
    }
  }
  return false
}

interface StartCommand {
  command: string
  args: string[]
  printable: string
  /** Чем плох сам способ запуска: отсутствие штатной команды — тоже дефект. */
  findings: RuntimeFinding[]
}

/**
 * Чем запускать проект.
 *
 * Порядок повторяет то, что сделает заказчик: сначала `npm start`, потом поле
 * main, потом привычные точки входа. Замечания копятся, а поиск продолжается:
 * сломанное поле main не должно мешать проверить всё остальное — иначе один
 * дефект прячет за собой остальные.
 */
function findStartCommand(dir: string, pkg: PackageJson | null): StartCommand | null {
  if (pkg?.scripts?.start) {
    return { command: 'npm', args: ['start'], printable: 'npm start', findings: [] }
  }

  const findings: RuntimeFinding[] = [
    {
      severity: 'hard',
      text:
        'В package.json нет скрипта "start" — приложение нечем запустить штатной командой. ' +
        'Добавь "start" и убедись, что поле "main" указывает на существующий файл.',
    },
  ]

  const main = pkg?.main
  if (main && fs.existsSync(path.join(dir, main))) {
    return { command: 'node', args: [main], printable: `node ${main}`, findings }
  }
  if (main) {
    findings.push({
      severity: 'hard',
      text: `Поле "main" в package.json указывает на ${main}, но такого файла нет — "node ." не сработает.`,
    })
  }

  for (const candidate of ['dist/server.js', 'dist/index.js', 'dist/main.js', 'server.js', 'index.js', 'app.js']) {
    if (fs.existsSync(path.join(dir, candidate))) {
      return { command: 'node', args: [candidate], printable: `node ${candidate}`, findings }
    }
  }
  if (pkg?.scripts?.dev) {
    return { command: 'npm', args: ['run', 'dev'], printable: 'npm run dev', findings }
  }
  for (const candidate of ['main.py', 'app.py', 'server.py']) {
    if (fs.existsSync(path.join(dir, candidate))) {
      return { command: 'python', args: [candidate], printable: `python ${candidate}`, findings: [] }
    }
  }
  // Точки входа нет вовсе — запускать нечем, но про main всё равно скажем.
  return main ? { command: 'node', args: [main], printable: `node ${main}`, findings } : null
}

/** Свободный порт: занимать чужой 3000 у пользователя мы не имеем права. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', () => resolve(3100 + Math.floor(Math.random() * 500)))
  })
}

async function probe(url: string, init?: RequestInit): Promise<{ status: number; type: string; body: string } | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT) })
    const body = await res.text()
    return { status: res.status, type: res.headers.get('content-type') ?? '', body }
  } catch {
    return null
  }
}

/** Ответ, в котором наружу уехала трасса исключения. */
function looksLikeStackTrace(body: string): boolean {
  return /\b(at\s+\w[\w.$]*\s*\(|Error:|Traceback \(most recent call last\))/.test(body) && /\n|<br>/.test(body)
}

/**
 * Текст внутреннего исключения в ответе клиенту.
 *
 * Код возврата при этом бывает правильным: обработчик ловит TypeError и
 * отдаёт 400. Но сам текст выдаёт кухню и означает, что валидации ввода нет —
 * 400 получился случайно, через перехваченное исключение.
 */
const LEAKED_EXCEPTION = [
  /is not a function/i,
  /Cannot read propert(?:y|ies) of (?:undefined|null)/i,
  /Cannot destructure/i,
  /is not defined\b/i,
  /object has no attribute/i,
  /unsupported operand type/i,
]

function leakedExceptionText(body: string): string | null {
  if (body.length > 4000) return null
  const hit = LEAKED_EXCEPTION.find((re) => re.test(body))
  if (!hit) return null
  return (body.match(hit)?.[0] ?? '').slice(0, 120)
}

/**
 * Статика, подключённая относительным путём.
 *
 * `express.static('public')` разрешается от рабочей директории, а не от файла,
 * поэтому приложение отдаёт страницу только при запуске из корня проекта.
 * Проверяется по исходникам: запуск-то мы делаем как раз из корня, где это
 * работает, — увидеть проблему в момент обращения нельзя.
 */
function relativeStaticFindings(dir: string): RuntimeFinding[] {
  const out: RuntimeFinding[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > 4 || out.length > 0) return
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', '__pycache__', 'venv', '.venv'].includes(item.name)) continue
        walk(path.join(current, item.name), depth + 1)
        continue
      }
      if (!/\.(ts|js|mjs|cjs)$/.test(item.name)) continue
      try {
        const text = fs.readFileSync(path.join(current, item.name), 'utf-8')
        const m = text.match(/express\s*\.\s*static\s*\(\s*['"`]([^'"`]+)['"`]/)
        if (m) {
          out.push({
            severity: 'soft',
            text: `Статика подключена относительным путём: express.static('${m[1]}'). Приложение отдаёт страницу только при запуске из корня проекта — надёжнее path.join(__dirname, ...).`,
          })
          return
        }
      } catch {
        /* нечитаемый файл — пропускаем */
      }
    }
  }
  walk(dir, 0)
  return out
}

interface Route {
  method: 'GET' | 'POST'
  path: string
}

/**
 * Пути, объявленные в исходниках. Разбирать код целиком не нужно: достаточно
 * найти, куда вообще можно постучаться, — дальше отвечает сам сервер.
 * Пути с параметрами пропускаем: подставить осмысленный id всё равно нечем.
 */
function extractRoutes(dir: string): Route[] {
  const out: Route[] = []
  const seen = new Set<string>()

  const patterns: { re: RegExp; method: Route['method'] }[] = [
    { re: /\b(?:app|router)\s*\.\s*get\s*\(\s*['"`]([^'"`]+)['"`]/g, method: 'GET' },
    { re: /\b(?:app|router)\s*\.\s*post\s*\(\s*['"`]([^'"`]+)['"`]/g, method: 'POST' },
    { re: /@\w+\.get\s*\(\s*['"]([^'"]+)['"]/g, method: 'GET' },
    { re: /@\w+\.post\s*\(\s*['"]([^'"]+)['"]/g, method: 'POST' },
  ]

  const walk = (current: string, depth: number): void => {
    if (depth > 4 || out.length >= MAX_ROUTES * 3) return
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', '__pycache__', 'venv', '.venv'].includes(item.name)) continue
        walk(path.join(current, item.name), depth + 1)
        continue
      }
      if (!/\.(ts|js|mjs|cjs|py)$/.test(item.name)) continue
      let text: string
      try {
        text = fs.readFileSync(path.join(current, item.name), 'utf-8')
      } catch {
        continue
      }
      for (const { re, method } of patterns) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          const route = m[1]
          if (!route.startsWith('/')) continue
          if (/[:{*]/.test(route)) continue
          const key = `${method} ${route}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ method, path: route })
        }
      }
    }
  }

  walk(dir, 0)
  return out.slice(0, MAX_ROUTES)
}

/** Собирает снимок страницы: с чем можно взаимодействовать и как это адресовать. */
const SNAPSHOT_JS = `(() => {
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    const cls = (el.className || '').toString().trim().split(/\\s+/).filter(Boolean)[0];
    if (cls) return el.tagName.toLowerCase() + '.' + CSS.escape(cls);
    return el.tagName.toLowerCase();
  };
  const nodes = [...document.querySelectorAll('input, textarea, select, button, a[href], [role="button"], li, [type="checkbox"]')];
  const elements = nodes.slice(0, 40).map((el) => ({
    selector: sel(el),
    tag: el.tagName.toLowerCase(),
    type: el.type || undefined,
    text: (el.innerText || el.value || '').toString().trim().slice(0, 60) || undefined,
    placeholder: el.placeholder || undefined,
    disabled: el.disabled === true || undefined,
  }));
  return {
    title: document.title,
    elements,
    html: document.body ? document.body.innerHTML.slice(0, 4000) : '',
  };
})()`

/** Один шаг сценария превращается в короткий известный фрагмент кода. */
function stepScript(step: ScenarioStep): string {
  const sel = 'selector' in step ? JSON.stringify(step.selector) : '""'
  switch (step.action) {
    case 'fill':
      return `(() => {
        const el = document.querySelector(${sel});
        if (!el) return 'no-element';
        if (el.disabled) return 'disabled';
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, ${JSON.stringify(step.value)});
        else el.value = ${JSON.stringify(step.value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`
    case 'click':
      return `(() => {
        const el = document.querySelector(${sel});
        if (!el) return 'no-element';
        if (el.disabled) return 'disabled';
        if (el.getAttribute('aria-disabled') === 'true') return 'disabled';
        el.click();
        return 'ok';
      })()`
    case 'waitFor':
      return `document.querySelector(${sel}) ? 'ok' : 'missing'`
    case 'expectText':
      return `(document.body && document.body.innerText.includes(${JSON.stringify(step.value)})) ? 'ok' : 'absent'`
    case 'expectChecked':
      return `(() => {
        const el = document.querySelector(${sel});
        if (!el) return 'no-element';
        return el.checked === true ? 'ok' : 'not-checked';
      })()`
    case 'expectEnabled':
      return `(() => {
        const el = document.querySelector(${sel});
        if (!el) return 'no-element';
        return el.disabled === true ? 'disabled' : 'ok';
      })()`
  }
}

function describeStep(step: ScenarioStep): string {
  switch (step.action) {
    case 'fill': return `ввести «${step.value}» в ${step.selector}`
    case 'click': return `нажать ${step.selector}`
    case 'waitFor': return `дождаться ${step.selector}`
    case 'expectText': return `увидеть на странице «${step.value}»`
    case 'expectChecked': return `${step.selector} должен стать отмеченным`
    case 'expectEnabled': return `${step.selector} должен быть доступен`
  }
}

/**
 * Разбор результата шага.
 *
 * Разделение важное. Ненайденный элемент — скорее ошибка сценария, чем
 * приложения: Тестер мог выдумать селектор, и превращать это в провал приёмки
 * нельзя. А вот отключённый элемент, невыполненное ожидание текста или
 * неотметившийся флажок — это приложение не делает того, что должно.
 */
function judgeStep(
  step: ScenarioStep,
  code: string
): { ok: boolean; detail: string; severity: 'hard' | 'soft'; keepGoing?: boolean } {
  if (code === 'ok') return { ok: true, detail: 'выполнено', severity: 'soft' }
  if (code === 'missing') {
    // Ждали элемент, которого не дождались. Сам по себе это не приговор:
    // Тестер мог назвать класс, которого в приложении нет. Но и бросать
    // сценарий рано — судить должен следующий шаг, который проверяет
    // обещанный результат. Если и он не сойдётся, дело не в селекторе.
    return {
      ok: false,
      severity: 'soft',
      keepGoing: true,
      detail: `не дождались элемента ${'selector' in step ? step.selector : ''}`,
    }
  }
  if (code === 'no-element') {
    // А вот действовать не над чем: дальше сценарий бессмысленный.
    return {
      ok: false,
      severity: 'soft',
      detail: `элемент ${'selector' in step ? step.selector : ''} не найден на странице`,
    }
  }
  if (code === 'disabled') {
    return {
      ok: false,
      severity: 'hard',
      detail: `элемент ${'selector' in step ? step.selector : ''} отключён — пользователь не может им воспользоваться`,
    }
  }
  if (code === 'absent') {
    return { ok: false, severity: 'hard', detail: 'ожидаемого текста на странице не появилось' }
  }
  if (code === 'not-checked') {
    return { ok: false, severity: 'hard', detail: 'элемент не стал отмеченным' }
  }
  return { ok: false, severity: 'soft', detail: `непонятный результат: ${code}` }
}

interface PageResult {
  findings: RuntimeFinding[]
  scenario: ScenarioOutcome[]
  layout: { before: LayoutReport; after: LayoutReport | null } | null
  screenshot: string | null
}

/**
 * Отдаёт замечания дизайнеру и перепроверяет результат.
 *
 * Правка идёт, пока приложение поднято: файлы переписываются на диске, страница
 * перечитывается, мерки снимаются заново. Так в отчёт попадает результат, а не
 * обещание — если дизайнер сделал хуже, это видно числами.
 */
async function runDesign(
  contents: Electron.WebContents,
  url: string,
  opts: RuntimeOptions,
  layout: NonNullable<PageResult['layout']>,
  findings: RuntimeFinding[]
): Promise<void> {
  if (!opts.design || layout.before.findings.length === 0) return

  const snap = (await contents.executeJavaScript(SNAPSHOT_JS).catch(() => null)) as Omit<
    PageSnapshot,
    'url'
  > | null
  if (!snap) return

  opts.onProgress?.({ kind: 'design_start' })

  let wrote = false
  try {
    wrote = await opts.design({ url, ...snap }, layout.before)
  } catch {
    opts.onProgress?.({ kind: 'design_done', wrote: false })
    return
  }
  if (!wrote) {
    opts.onProgress?.({ kind: 'design_done', wrote: false })
    return
  }

  const reloaded = await Promise.race([
    contents.loadURL(url).then(() => true).catch(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), PAGE_TIMEOUT)),
  ])
  if (!reloaded) {
    findings.push({ severity: 'hard', text: 'После правки оформления страница перестала открываться' })
    opts.onProgress?.({ kind: 'design_done', wrote: true })
    return
  }
  await new Promise((r) => setTimeout(r, 1500))
  layout.after = await auditLayout(contents)
  await snapshotNow(contents, opts)
  opts.onProgress?.({ kind: 'design_done', wrote: true })

  // Дизайнер обязан улучшать. Если замечаний стало больше — это регрессия, и
  // молчать о ней нельзя, хотя приёмку из-за оформления мы не валим.
  if (layout.after.findings.length > layout.before.findings.length) {
    findings.push({
      severity: 'soft',
      text: `После правки оформления замечаний стало больше: было ${layout.before.findings.length}, стало ${layout.after.findings.length}`,
    })
  }
}

/**
 * Снимок страницы прямо сейчас — вызывается несколько раз за прогон (после
 * загрузки, после каждого шага сценария, после правки дизайнера), каждый раз
 * перезаписывая один и тот же файл. Так у панели конвейера получается эффект
 * «живой камеры» без потоковой передачи видео: она просто перечитывает файл
 * при каждом обновлении прогона.
 */
async function snapshotNow(
  contents: Electron.WebContents,
  opts: RuntimeOptions
): Promise<string | null> {
  if (!opts.screenshotPath) return null
  try {
    const image = await contents.capturePage()
    if (image.isEmpty()) return null
    fs.mkdirSync(path.dirname(opts.screenshotPath), { recursive: true })
    fs.writeFileSync(opts.screenshotPath, image.toPNG())
    opts.onProgress?.({ kind: 'screenshot', path: opts.screenshotPath })
    return opts.screenshotPath
  } catch {
    return null
  }
}

/**
 * Открывает страницу в скрытом окне: собирает ошибки консоли, снимает состав
 * страницы и, если Тестер прислал сценарий, проигрывает его как пользователь.
 */
async function inspectPage(url: string, opts: RuntimeOptions): Promise<PageResult> {
  const findings: RuntimeFinding[] = []
  const scenario: ScenarioOutcome[] = []
  let layout: PageResult['layout'] = null
  let screenshot: string | null = null
  let win: BrowserWindow | null = null

  try {
    win = new BrowserWindow({
      show: false,
      // Размер задан явно: по умолчанию окно 800×600, и мерки вёрстки снимались
      // бы с экрана, на котором приложение никто не смотрит. Ширина колонки и
      // растянутость содержимого видны только на настоящем рабочем столе.
      width: 1280,
      height: 800,
      webPreferences: {
        // Страницу написала модель: никакого доступа к Node, изоляция и песочница.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const errors: string[] = []
    win.webContents.on('console-message', (_e, level, message) => {
      // 3 — уровень error в Chromium.
      if (level >= 3 && errors.length < 5) errors.push(message.slice(0, 200))
    })

    opts.onProgress?.({ kind: 'opening', url })
    const loaded = await Promise.race([
      win.loadURL(url).then(() => true).catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), PAGE_TIMEOUT)),
    ])

    if (!loaded) {
      findings.push({ severity: 'hard', text: `Страница ${url} не загрузилась в браузере` })
      return { findings, scenario, layout, screenshot }
    }

    // Даём отработать скриптам страницы: ошибки чаще всего вылезают после
    // первого fetch к своему же API.
    await new Promise((r) => setTimeout(r, 2500))

    const contents = win.webContents
    const empty = await contents
      .executeJavaScript('document.body ? document.body.innerText.trim().length : 0')
      .catch(() => -1)
    if (empty === 0) {
      findings.push({ severity: 'hard', text: 'Страница открывается, но в теле документа нет ни одного видимого символа' })
    }

    for (const e of errors) {
      findings.push({ severity: 'hard', text: `Ошибка в консоли браузера: ${e}` })
    }

    // --- Мерки вёрстки -------------------------------------------------------
    // Снимаем до сценария и, если дизайнер что-то правил, ещё раз после
    // перезагрузки — в обоих случаях на одном и том же состоянии страницы,
    // иначе «до» и «после» окажутся про разные экраны и сравнивать будет нечего.
    layout = { before: await auditLayout(contents), after: null }

    // Первый снимок — сразу как страница осела, до всякого сценария: уже
    // здесь видно, поднялось приложение или нет, а не только в самом конце.
    screenshot = (await snapshotNow(contents, opts)) ?? screenshot

    // --- Пользовательский сценарий ------------------------------------------
    // Шаги идут по порядку и без обходных путей: сценарий может не составиться,
    // но правку оформления и снимок это пропускать не должно.
    await runScenario(contents, url, opts, scenario, findings, errors)

    await runDesign(contents, url, opts, layout, findings)
    // Финальный снимок — гарантирует свежий кадр, даже если ни сценарий, ни
    // дизайнер ничего не переснимали (сценарий не составился, замечаний не было).
    screenshot = (await snapshotNow(contents, opts)) ?? screenshot
  } catch (e) {
    findings.push({ severity: 'soft', text: `Не удалось открыть страницу: ${(e as Error).message}` })
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }

  return { findings, scenario, layout, screenshot }
}

/**
 * Проигрывает сценарий Тестера, если он его прислал.
 *
 * Все отказы тихие: не составился снимок страницы, модель не ответила, шагов
 * нет — это не дефект приложения, а отсутствие сценария.
 */
async function runScenario(
  contents: Electron.WebContents,
  url: string,
  opts: RuntimeOptions,
  scenario: ScenarioOutcome[],
  findings: RuntimeFinding[],
  errors: string[]
): Promise<void> {
  if (!opts.scenario) return

  const snap = (await contents.executeJavaScript(SNAPSHOT_JS).catch(() => null)) as Omit<
    PageSnapshot,
    'url'
  > | null
  if (!snap) return

  let steps: ScenarioStep[] = []
  try {
    steps = await opts.scenario({ url, ...snap })
  } catch {
    return
  }
  if (steps.length === 0) return

  {
    for (const [i, step] of steps.entries()) {
      const description = describeStep(step)
      opts.onProgress?.({ kind: 'step', index: i + 1, total: steps.length, description, ok: null })

      let code = 'error'
      if (step.action === 'waitFor') {
        // Список задач появляется после ответа сервера — ждём, а не проверяем сразу.
        const until = Date.now() + Math.min(step.timeoutMs ?? 4000, 10_000)
        do {
          code = (await contents.executeJavaScript(stepScript(step)).catch(() => 'error')) as string
          if (code === 'ok') break
          await new Promise((r) => setTimeout(r, 250))
        } while (Date.now() < until)
      } else {
        code = (await contents.executeJavaScript(stepScript(step)).catch(() => 'error')) as string
        // После действия странице нужно время на запрос к своему API.
        if (step.action === 'click' || step.action === 'fill') {
          await new Promise((r) => setTimeout(r, 900))
        }
      }

      const verdict = judgeStep(step, code)
      scenario.push({ step, ok: verdict.ok, detail: verdict.detail })
      opts.onProgress?.({ kind: 'step', index: i + 1, total: steps.length, description, ok: verdict.ok })
      // Снимок только после действий, меняющих картинку: waitFor/expect* —
      // чистая проверка, экран после них не отличается от того, что уже
      // сняли на предыдущем шаге.
      if (step.action === 'fill' || step.action === 'click') {
        await snapshotNow(contents, opts)
      }
      if (!verdict.ok) {
        findings.push({
          severity: verdict.severity,
          text: verdict.keepGoing
            ? `Сценарий пользователя, шаг «${describeStep(step)}»: ${verdict.detail}`
            : `Сценарий пользователя оборвался на шаге «${describeStep(step)}»: ${verdict.detail}`,
        })
        if (!verdict.keepGoing) break
      }
    }

    for (const e of errors.slice(findings.filter((f) => f.text.startsWith('Ошибка в консоли')).length)) {
      findings.push({ severity: 'hard', text: `Ошибка в консоли браузера во время сценария: ${e}` })
    }
  }
}

function summarize(
  findings: RuntimeFinding[],
  probed: string[],
  scenario: ScenarioOutcome[],
  layout: { before: LayoutReport; after: LayoutReport | null } | null = null
): string {
  const lines: string[] = []
  if (probed.length) lines.push('Проверено запросами:', ...probed.map((p) => `  ${p}`), '')
  if (scenario.length) {
    lines.push('Проигран сценарий пользователя:')
    for (const s of scenario) lines.push(`  ${s.ok ? '✓' : '✗'} ${describeStep(s.step)} — ${s.detail}`)
    lines.push('')
  }
  if (layout) {
    const shown = layout.after ?? layout.before
    lines.push(
      layout.after
        ? `Вёрстка после правки дизайнера (было замечаний ${layout.before.findings.length}, стало ${layout.after.findings.length}):`
        : 'Вёрстка по меркам:'
    )
    lines.push(describeLayout(shown), '')
  }
  if (findings.length === 0) {
    lines.push('Приложение поднялось и отвечает, замечаний нет.')
  } else {
    lines.push('Замечания по работающему приложению:')
    for (const f of findings) lines.push(`  [${f.severity === 'hard' ? 'БЛОКЕР' : 'замечание'}] ${f.text}`)
  }
  return lines.join('\n')
}

/**
 * Поднимает проект и стучится в него так, как это сделает браузер заказчика
 * и как это сделает кривой клиент.
 */
export async function runRuntimeCheck(cwd?: string, opts: RuntimeOptions = {}): Promise<RuntimeReport> {
  const dir = cwd ?? getProjectDir()

  /*
   * Приложение не обязано лежать в корне: конвейер сам раскладывает крупные
   * задачи на backend/ и frontend/. Поднимаем ту половину, которая похожа на
   * сервер; вторую не трогаем — у неё свой запуск, и требовать от бэкенда
   * отдавать страницу фронтенда было бы ложным замечанием.
   */
  const roots = findManifestRoots(dir)
  const candidates = roots.length > 0 ? roots : [dir]
  const webRoots = candidates.filter((d) => looksLikeWebApp(d, readPackageJson(d)))
  // Из нескольких половин запускаем ту, у которой есть штатная команда запуска:
  // порядок папок в алфавите к делу отношения не имеет.
  const appDir = webRoots.find((d) => readPackageJson(d)?.scripts?.start) ?? webRoots[0]
  if (!appDir) return NOT_APPLICABLE

  const pkg = readPackageJson(appDir)
  const separatePackages = candidates.filter((d) => d !== appDir)
  const start = findStartCommand(appDir, pkg)
  if (!start) {
    const findings: RuntimeFinding[] = [
      { severity: 'hard', text: 'Не нашлось команды, которой можно запустить приложение: нет ни скрипта start, ни точки входа.' },
    ]
    return { ran: true, ok: false, findings, scenario: [], layout: null, screenshot: null, summary: summarize(findings, [], []) }
  }

  const findings: RuntimeFinding[] = [...start.findings]

  const port = await freePort()
  let output = ''
  let exited: number | null = null

  // shell: true нужен из-за npm.cmd на Windows — так же, как в command-runner.
  const proc: ChildProcess = spawn(start.command, start.args, {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
    // NODE_ENV намеренно не трогаем: в production Express прячет трассу
    // исключения в своём обработчике по умолчанию, и проверка перестала бы
    // видеть утечку. Заказчик запускает без этой переменной — и мы тоже.
    env: { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
  })
  current = proc
  opts.onProgress?.({ kind: 'starting', command: start.printable })
  proc.stdout?.on('data', (d: Buffer) => (output += d.toString()))
  proc.stderr?.on('data', (d: Buffer) => (output += d.toString()))
  proc.on('close', (code) => (exited = code))

  try {
    // Порт мог быть захардкожен в обход переменной окружения, поэтому кроме
    // назначенного пробуем то, что сервер сам написал в вывод, и привычные.
    const candidates = (): number[] => {
      const fromOutput = [...output.matchAll(/(?:localhost|127\.0\.0\.1|порт|port)\D{0,3}(\d{4,5})/gi)].map((m) =>
        Number(m[1])
      )
      return [...new Set([port, ...fromOutput, 3000, 8000, 8080, 5000])]
    }

    let base: string | null = null
    const until = Date.now() + READY_TIMEOUT
    while (Date.now() < until && base === null) {
      if (exited !== null) break
      for (const candidate of candidates()) {
        const res = await probe(`http://127.0.0.1:${candidate}/`)
        if (res) {
          base = `http://127.0.0.1:${candidate}`
          break
        }
      }
      if (base === null) await new Promise((r) => setTimeout(r, 500))
    }

    if (base === null) {
      const tail = output.trim().slice(-1500)
      findings.push({
        severity: 'hard',
        text:
          exited !== null
            ? `Приложение завершилось с кодом ${exited} вместо того, чтобы слушать порт. Команда: ${start.printable}. Вывод:\n${tail || '(пусто)'}`
            : `Приложение не начало отвечать за ${READY_TIMEOUT / 1000} секунд. Команда: ${start.printable}. Вывод:\n${tail || '(пусто)'}`,
      })
      return { ran: true, ok: false, findings, scenario: [], layout: null, screenshot: null, summary: summarize(findings, [], []) }
    }

    opts.onProgress?.({ kind: 'up', url: base })

    const probed: string[] = []
    // Страницу ищем только в запущенном пакете: если фронтенд лежит отдельно,
    // его index.html к этому серверу отношения не имеет.
    const hasPage = fs.existsSync(path.join(appDir, 'public', 'index.html'))
    if (separatePackages.length > 0) {
      findings.push({
        severity: 'soft',
        text:
          `Проверен только запущенный пакет (${path.basename(appDir)}). Отдельно лежащие ` +
          `${separatePackages.map((d) => path.basename(d)).join(', ')} не запускались: ` +
          'у них своя сборка и свой запуск.',
      })
    }

    const root = await probe(`${base}/`)
    if (root) {
      probed.push(`GET / → ${root.status}`)
      if (hasPage && root.status === 404) {
        findings.push({
          severity: 'hard',
          text: 'В проекте есть public/index.html, но GET / отвечает 404 — статика не отдаётся. Обычная причина: путь к папке указан относительно рабочей директории вместо __dirname.',
        })
      }
      if (looksLikeStackTrace(root.body)) {
        findings.push({ severity: 'hard', text: 'Ответ на GET / содержит трассу исключения' })
      }
    }

    for (const route of extractRoutes(dir)) {
      if (route.method === 'GET') {
        const res = await probe(`${base}${route.path}`)
        if (!res) continue
        probed.push(`GET ${route.path} → ${res.status}`)
        if (res.status >= 500) {
          findings.push({ severity: 'hard', text: `GET ${route.path} отвечает ${res.status}: ${res.body.slice(0, 200)}` })
        } else if (looksLikeStackTrace(res.body)) {
          findings.push({ severity: 'hard', text: `GET ${route.path} возвращает трассу исключения наружу` })
        }
        continue
      }

      // Кривой клиент: пустое тело, битый JSON и JSON без ожидаемых полей.
      const attempts: { label: string; init: RequestInit }[] = [
        { label: 'без тела', init: { method: 'POST' } },
        {
          label: 'битый JSON',
          init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{сломано' },
        },
        {
          label: 'пустой объект',
          init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        },
      ]
      for (const attempt of attempts) {
        const res = await probe(`${base}${route.path}`, attempt.init)
        if (!res) continue
        probed.push(`POST ${route.path} (${attempt.label}) → ${res.status}`)
        if (res.status >= 500) {
          findings.push({
            severity: 'hard',
            text: `POST ${route.path} с телом «${attempt.label}» отвечает ${res.status} — некорректный ввод не должен ронять сервер, ожидается 400.`,
          })
        }
        const leaked = leakedExceptionText(res.body)
        if (leaked) {
          findings.push({
            severity: 'hard',
            text: `POST ${route.path} с телом «${attempt.label}» отдаёт клиенту текст внутреннего исключения («${leaked}»). Значит, проверки входных данных нет — код возврата получился случайно. Проверь тип и содержимое полей явно.`,
          })
        }
        if (looksLikeStackTrace(res.body)) {
          findings.push({
            severity: 'hard',
            text: `POST ${route.path} с телом «${attempt.label}» возвращает трассу исключения наружу. Нужен обработчик ошибок, отвечающий JSON без внутренних подробностей.`,
          })
        } else if (route.path.includes('/api/') && res.type.includes('text/html')) {
          findings.push({
            severity: 'soft',
            text: `POST ${route.path} с телом «${attempt.label}» отвечает HTML вместо JSON`,
          })
        }
      }
    }

    let scenario: ScenarioOutcome[] = []
    let layout: RuntimeReport['layout'] = null
    let screenshot: string | null = null
    if (root && root.status === 200 && root.type.includes('html')) {
      const page = await inspectPage(`${base}/`, opts)
      findings.push(...page.findings)
      scenario = page.scenario
      layout = page.layout
      screenshot = page.screenshot
      findings.push(...relativeStaticFindings(dir))
    }

    const ok = !findings.some((f) => f.severity === 'hard')
    return {
      ran: true,
      ok,
      findings,
      scenario,
      layout,
      screenshot,
      summary: summarize(findings, probed, scenario, layout),
    }
  } finally {
    await terminate(proc)
    current = null
  }
}
