import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { resolveInProject, getActiveProjectId, getProjectDir } from './projects'
import { getDataDir } from './paths'
import { runRuntimeCheck } from './runtime-check'

let devServer: ChildProcess | null = null
let serverUrl: string | null = null
let logs: string[] = []
/** Окно-попап «Просмотра» — на весь экран проекта, отдельно от тесной боковой панели. */
let popoutWindow: BrowserWindow | null = null

const MAX_LOG_LINES = 200
const STARTUP_TIMEOUT_MS = 30_000

/**
 * Снимок ручной проверки — отдельный файл от того, что пишет конвейер
 * (`screenshotPathFor` в orchestrator.ts): ручной прогон может случиться
 * параллельно с прогоном конвейера по другому проекту, и они не должны
 * затирать друг другу картинку.
 */
function manualScreenshotPath(projectId: string): string {
  return path.join(getDataDir(), 'previews', `${projectId}-manual.png`)
}

function pushLog(line: string): void {
  for (const l of line.split('\n')) {
    const t = l.trimEnd()
    if (t) logs.push(t)
  }
  if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES)
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

function guessPort(dir: string, pkg: { dependencies?: Record<string, string> }): number {
  const hasVite =
    fs.existsSync(path.join(dir, 'vite.config.ts')) ||
    fs.existsSync(path.join(dir, 'vite.config.js'))
  const hasCRA = Boolean(pkg.dependencies?.['react-scripts'])
  if (hasVite) return 5173
  if (hasCRA) return 3000
  return 3000
}

/** Ждём, пока dev-сервер сам напечатает свой URL. Это надёжнее фиксированной паузы. */
function waitForUrl(fallbackUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now()
    const urlRe = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"']*/i

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

  const feDir = resolveInProject(projectPath || 'frontend')
  if (!feDir || !fs.existsSync(feDir)) {
    return { success: false, url: null, error: `Папка "${projectPath}" не найдена в папке проекта` }
  }

  const pkgPath = path.join(feDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return { success: false, url: null, error: 'В папке нет package.json' }
  }

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch {
    return { success: false, url: null, error: 'package.json повреждён' }
  }
  if (!pkg.scripts?.dev) {
    return { success: false, url: null, error: 'В package.json нет скрипта "dev"' }
  }
  if (!fs.existsSync(path.join(feDir, 'node_modules'))) {
    return {
      success: false,
      url: null,
      error: 'Не установлены зависимости. Выполните "npm install" в этой папке.',
    }
  }

  const port = guessPort(feDir, pkg)
  const fallbackUrl = `http://localhost:${port}`
  logs = []

  // shell: true обязателен: начиная с Node 18.20/20.12 spawn отказывается
  // запускать .cmd-файлы (в том числе npm.cmd) без него.
  devServer = spawn('npm', ['run', 'dev'], {
    cwd: feDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
  })

  devServer.stdout?.on('data', (d: Buffer) => pushLog(d.toString()))
  devServer.stderr?.on('data', (d: Buffer) => pushLog(d.toString()))
  devServer.on('error', (err) => {
    pushLog(`[ошибка запуска] ${err.message}`)
    devServer = null
    serverUrl = null
  })
  devServer.on('close', (code) => {
    pushLog(`[dev-сервер завершился, код ${code}]`)
    devServer = null
    serverUrl = null
  })

  const url = await waitForUrl(fallbackUrl)
  if (!devServer) {
    return { success: false, url: null, error: 'Dev-сервер завершился при старте. См. логи.' }
  }

  serverUrl = url
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
