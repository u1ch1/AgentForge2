import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { resolveInProject, getActiveProjectId, getProjectDir, toProjectRelative } from './projects'
import { getDataDir } from './paths'
import { runRuntimeCheck } from './runtime-check'
import { findManifestRoots } from './command-runner'

interface PkgJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
}

let devServer: ChildProcess | null = null
let serverUrl: string | null = null
let currentProjectId: string | null = null
let logs: string[] = []
/** Окно-попап «Просмотра» — на весь экран проекта, отдельно от тесной боковой панели. */
let popoutWindow: BrowserWindow | null = null

export type BackendStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error'

/**
 * Вторая половина split-проекта (backend/) поднимается вместе с фронтендом
 * автоматически — раньше пользователю приходилось идти в отдельный терминал
 * и запускать её руками, а фронтенд без бэкенда просто показывает
 * "Failed to fetch" на любой странице с данными.
 */
let backendServer: ChildProcess | null = null
let backendDir: string | null = null
let backendStatus: BackendStatus = 'idle'
let backendError: string | null = null
let backendLogs: string[] = []

const MAX_LOG_LINES = 200
const STARTUP_TIMEOUT_MS = 30_000
/** Точного сигнала готовности у бэкенда нет (в отличие от фронтенда, который сам печатает свой URL) — ждём фиксированное время и считаем, что процесс, переживший его, поднялся. */
const BACKEND_READY_GUESS_MS = 2_500

/**
 * Снимок ручной проверки — отдельный файл от того, что пишет конвейер
 * (`screenshotPathFor` в orchestrator.ts): ручной прогон может случиться
 * параллельно с прогоном конвейера по другому проекту, и они не должны
 * затирать друг другу картинку.
 */
function manualScreenshotPath(projectId: string): string {
  return path.join(getDataDir(), 'previews', `${projectId}-manual.png`)
}

/**
 * Vite и другие dev-серверы красят вывод ANSI-кодами даже при `FORCE_COLOR: '0'`
 * в окружении — на практике не всегда это соблюдают. Без очистки код портит не
 * только читаемость лога, но и разбор адреса в waitForUrl(): регулярка ищет
 * первый непробельный кусок после `http://`, а невидимые управляющие символы
 * непробельные — они просачиваются прямо в URL, который потом грузит `<webview>`.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

function pushLog(line: string): void {
  for (const l of stripAnsi(line).split('\n')) {
    const t = l.trimEnd()
    if (t) logs.push(t)
  }
  if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES)
}

function pushBackendLog(line: string): void {
  for (const l of stripAnsi(line).split('\n')) {
    const t = l.trimEnd()
    if (t) backendLogs.push(t)
  }
  if (backendLogs.length > MAX_LOG_LINES) backendLogs = backendLogs.slice(-MAX_LOG_LINES)
}

/**
 * Убивает всё дерево процессов.
 *
 * На Windows `npm.cmd` порождает дочерний node — обычный kill() убивает только
 * обёртку, а сервер остаётся висеть на порту. Поэтому taskkill /T /F.
 */
function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      proc.kill('SIGTERM')
    }
  }
}

export function stopPreview(): void {
  if (devServer) {
    killTree(devServer)
    devServer = null
  }
  serverUrl = null
  currentProjectId = null

  if (backendServer) {
    killTree(backendServer)
    backendServer = null
  }
  backendDir = null
  backendStatus = 'idle'
  backendError = null
}

/**
 * Останавливает «Просмотр», только если он запущен именно для этого проекта —
 * вызывается конвейером перед своей проверкой (npm ci и т.д.), чтобы ручной
 * dev-сервер не держал файлы (esbuild.exe и т.п.) заблокированными и не ронял
 * конвейер по EPERM. Для другого проекта или пустого «Просмотра» — no-op.
 */
export function stopPreviewForProject(projectId: string): void {
  if (currentProjectId === projectId) stopPreview()
}

/**
 * Открывает текущий адрес «Просмотра» в отдельном полноразмерном окне —
 * тесная боковая панель годится для беглого взгляда, а не для того, чтобы
 * реально пользоваться приложением. Повторный вызов не плодит окна:
 * существующее просто выходит на передний план.
 */
export function openPreviewWindow(): { success: boolean; error?: string } {
  if (!serverUrl) return { success: false, error: 'Просмотр не запущен' }

  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus()
    return { success: true }
  }

  popoutWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'AgentForge Studio — Просмотр',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  popoutWindow.on('closed', () => {
    popoutWindow = null
  })
  void popoutWindow.loadURL(serverUrl)
  return { success: true }
}

function isViteProject(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'vite.config.ts')) || fs.existsSync(path.join(dir, 'vite.config.js'))
}

function guessPort(dir: string, pkg: { dependencies?: Record<string, string> }): number {
  const hasCRA = Boolean(pkg.dependencies?.['react-scripts'])
  if (isViteProject(dir)) return 5173
  if (hasCRA) return 3000
  return 3000
}

/**
 * Вторая папка с манифестом рядом с той, что выбрана как фронтенд — тем же
 * findManifestRoots(), которым уже пользуется автопроверка Тестера и
 * автоопределение самого feDir выше.
 */
function findBackendDir(feDir: string): string | null {
  return findManifestRoots().find((dir) => dir !== feDir && fs.existsSync(path.join(dir, 'package.json'))) ?? null
}

/**
 * Поднимает бэкенд рядом с фронтендом, если он есть — без этого фронтенд
 * split-проекта показывает "Failed to fetch" на любой странице с данными,
 * а пользователю приходится вручную идти в отдельный терминал. Не
 * блокирует запуск фронтенда: ошибки тут не фатальны для «Просмотра»,
 * только видны отдельной строкой в интерфейсе.
 */
function startBackend(feDir: string): void {
  if (backendServer) return

  const dir = findBackendDir(feDir)
  backendDir = dir
  if (!dir) {
    backendStatus = 'idle'
    backendError = null
    return
  }

  let pkg: PkgJson
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
  } catch {
    backendStatus = 'error'
    backendError = 'package.json повреждён'
    return
  }
  const scriptName = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : null
  if (!scriptName) {
    backendStatus = 'error'
    backendError = 'В package.json нет ни скрипта "dev", ни "start"'
    return
  }
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    backendStatus = 'error'
    backendError = 'Не установлены зависимости (npm install)'
    return
  }

  backendStatus = 'starting'
  backendError = null
  backendLogs = []

  const args = scriptName === 'start' ? ['start'] : ['run', scriptName]
  const proc = spawn('npm', args, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
    // HOST — на случай, если бэкенд, как и фронтенд, слушает явный "localhost"
    // вместо всех интерфейсов (см. resolveReachableUrl выше про эту же проблему).
    env: { ...process.env, HOST: '127.0.0.1', FORCE_COLOR: '0' },
  })
  backendServer = proc

  proc.stdout?.on('data', (d: Buffer) => pushBackendLog(d.toString()))
  proc.stderr?.on('data', (d: Buffer) => pushBackendLog(d.toString()))
  proc.on('error', (err) => {
    pushBackendLog(`[ошибка запуска] ${err.message}`)
    if (backendServer === proc) backendServer = null
    backendStatus = 'error'
    backendError = err.message
  })
  proc.on('close', (code) => {
    pushBackendLog(`[бэкенд завершился, код ${code}]`)
    if (backendServer === proc) backendServer = null
    if (backendStatus !== 'error') backendStatus = 'stopped'
  })

  setTimeout(() => {
    if (backendServer === proc && backendStatus === 'starting') backendStatus = 'running'
  }, BACKEND_READY_GUESS_MS)
}

/** Ждём, пока dev-сервер сам напечатает свой URL. Это надёжнее фиксированной паузы. */
function waitForUrl(fallbackUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now()
    const urlRe = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s"']*/i

    const timer = setInterval(() => {
      const match = logs.join('\n').match(urlRe)
      if (match) {
        clearInterval(timer)
        resolve(match[0].replace(/\/+$/, ''))
        return
      }
      if (!devServer || Date.now() - started > STARTUP_TIMEOUT_MS) {
        clearInterval(timer)
        resolve(fallbackUrl)
      }
    }, 400)
  })
}

function probeReachable(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * Node на Windows нередко резолвит "localhost" в dev-сервере не так, как
 * Chromium в <webview> — типичный случай: Vite слушает только [::1] (IPv6),
 * а гостевая страница пытается достучаться по 127.0.0.1 (IPv4) и получает
 * отказ в соединении, из-за чего «Просмотр» показывает пустой белый экран
 * при полностью рабочем dev-сервере. Подменяем хост в адресе на тот, что
 * реально принимает соединение, проверив оба явно — вместо того, чтобы
 * полагаться на то, как ОС угадает "localhost".
 */
async function resolveReachableUrl(url: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.hostname !== 'localhost') return url
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)

  if (await probeReachable('127.0.0.1', port)) {
    parsed.hostname = '127.0.0.1'
    return parsed.toString()
  }
  if (await probeReachable('::1', port)) {
    parsed.hostname = '[::1]'
    return parsed.toString()
  }
  return url
}

export interface PreviewStartOutcome {
  success: boolean
  url: string | null
  alreadyRunning?: boolean
  error?: string
}

/**
 * Общая механика запуска, вынесенная из IPC-обработчика: её же вызывает
 * автозапуск при старте приложения (см. main.ts), а не только кнопка «Старт».
 */
export async function startPreview(projectPath: string): Promise<PreviewStartOutcome> {
  if (devServer && serverUrl) {
    return { success: true, url: serverUrl, alreadyRunning: true }
  }

  let feDir = resolveInProject(projectPath || 'frontend')

  // Поле по умолчанию указывает на корень проекта. Если там package.json нет,
  // а путь никто не менял — конвейер мог разложить проект на подпапки
  // (frontend/ + backend/), как для крупных задач: ищем манифесты тем же
  // способом, что и автопроверка Тестера (findManifestRoots), и берём ту
  // половину, у которой есть браузерный dev/start — не бэкенд без страницы.
  const isDefaultPath = !projectPath.trim() || projectPath.trim() === '.'
  if (isDefaultPath && (!feDir || !fs.existsSync(path.join(feDir, 'package.json')))) {
    const candidates = findManifestRoots()
      .map((dir) => {
        try {
          return { dir, pkg: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as PkgJson }
        } catch {
          return null
        }
      })
      .filter(
        (c): c is { dir: string; pkg: PkgJson } => c !== null && Boolean(c.pkg.scripts?.dev || c.pkg.scripts?.start)
      )
    const guess = candidates.find((c) => c.pkg.scripts?.dev) ?? candidates[0]
    if (guess) feDir = guess.dir
  }

  if (!feDir || !fs.existsSync(feDir)) {
    return { success: false, url: null, error: `Папка "${projectPath}" не найдена в папке проекта` }
  }

  const pkgPath = path.join(feDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return { success: false, url: null, error: 'В папке нет package.json' }
  }

  let pkg: PkgJson
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch {
    return { success: false, url: null, error: 'package.json повреждён' }
  }
  // "dev" — обычный дев-сервер с горячей перезагрузкой (Vite/CRA). Но конвейер
  // сам решает, какие скрипты класть в package.json, и по умолчанию рассчитан
  // на "start" (это то, что в первую очередь пробует автопроверка Тестера в
  // runtime-check.ts) — без запасного варианта такие проекты в «Просмотре» не
  // открывались бы вовсе, хотя штатно запускаются.
  const scriptName = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : null
  if (!scriptName) {
    return { success: false, url: null, error: 'В package.json нет ни скрипта "dev", ни "start"' }
  }
  if (!fs.existsSync(path.join(feDir, 'node_modules'))) {
    return {
      success: false,
      url: null,
      error: 'Не установлены зависимости. Выполните "npm install" в этой папке.',
    }
  }

  const port = guessPort(feDir, pkg)
  // "localhost" на части Windows-машин резолвится в dev-сервере и в <webview>
  // по-разному (IPv4 у одного, IPv6-loopback у другого) — сервер поднимается
  // штатно, а «Просмотр» показывает белый экран, потому что достучаться не
  // может. Поэтому явно просим сервер слушать 127.0.0.1, а не гадаем постфактум,
  // какой адрес реально принимает соединение: для Vite — флагом --host (сам
  // Vite HOST из окружения не читает), для остальных (CRA и т.п.) — через
  // переменную HOST, которую они умеют понимать сами.
  const args: string[] =
    scriptName === 'dev'
      ? isViteProject(feDir)
        ? ['run', 'dev', '--', '--host', '127.0.0.1']
        : ['run', 'dev']
      : ['start']
  const fallbackUrl = `http://127.0.0.1:${port}`
  logs = []

  startBackend(feDir)

  // shell: true обязателен: начиная с Node 18.20/20.12 spawn отказывается
  // запускать .cmd-файлы (в том числе npm.cmd) без него.
  devServer = spawn('npm', args, {
    cwd: feDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', FORCE_COLOR: '0' },
  })

  devServer.stdout?.on('data', (d: Buffer) => pushLog(d.toString()))
  devServer.stderr?.on('data', (d: Buffer) => pushLog(d.toString()))
  devServer.on('error', (err) => {
    pushLog(`[ошибка запуска] ${err.message}`)
    devServer = null
    serverUrl = null
    currentProjectId = null
  })
  devServer.on('close', (code) => {
    pushLog(`[dev-сервер завершился, код ${code}]`)
    devServer = null
    serverUrl = null
    currentProjectId = null
  })

  const url = await resolveReachableUrl(await waitForUrl(fallbackUrl))
  if (!devServer) {
    return { success: false, url: null, error: 'Dev-сервер завершился при старте. См. логи.' }
  }

  serverUrl = url
  currentProjectId = getActiveProjectId()
  return { success: true, url, alreadyRunning: false }
}

export function registerLivePreviewIPC(): void {
  ipcMain.handle('preview:start', (_e: IpcMainInvokeEvent, projectPath: string) => startPreview(projectPath))

  ipcMain.handle('preview:stop', () => {
    stopPreview()
    return { success: true }
  })

  ipcMain.handle('preview:getUrl', () => ({ url: devServer ? serverUrl : null }))
  ipcMain.handle('preview:getLogs', () => ({ logs: [...logs] }))
  ipcMain.handle('preview:openWindow', () => openPreviewWindow())

  ipcMain.handle('preview:getBackendStatus', () => ({
    dir: backendDir ? toProjectRelative(backendDir) : null,
    status: backendStatus,
    error: backendError,
  }))
  ipcMain.handle('preview:getBackendLogs', () => ({ logs: [...backendLogs] }))

  // Проверка «подними и постучись» по требованию, отдельно от конвейера: без
  // сценария и дизайнера (это работа агентов, а ручная проверка не должна
  // тратить бюджет) — только запуск, зондирование и снимок. Отдаём наружу
  // обрезанную форму отчёта — preload не тянет типы из main, как и для
  // PipelineRun.runtime в src/shared/pipeline.ts.
  ipcMain.handle('preview:runChecks', async () => {
    const projectId = getActiveProjectId()
    const report = await runRuntimeCheck(getProjectDir(projectId), {
      screenshotPath: manualScreenshotPath(projectId),
    })
    return {
      ran: report.ran,
      ok: report.ok,
      findings: report.findings,
      screenshot: report.screenshot,
      summary: report.summary,
    }
  })
}
