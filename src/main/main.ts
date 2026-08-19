import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  IpcMainInvokeEvent,
} from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getWorkspaceDir, setWorkspaceDir, getDataDir } from './paths'
import { seedWorkspace } from './file-manager'
import { registerAPIIPC, loadPersistedKeys, refreshSystemPrompt } from './api-client'
import { registerProjectsIPC, getProjectDir, getActiveProject } from './projects'
import { registerChatIPC } from './chat-store'
import { registerFileOpsIPC } from './file-ops'
import { registerDecompositionIPC } from './decomposition'
import { registerExportIPC } from './export'
import { registerTemplateIPC } from './templates'
import { registerMemoryIPC } from './project-memory'
import { registerMCPIPC } from './mcp-server'
import { registerDeployIPC } from './deploy'
import { registerLivePreviewIPC, stopPreview, startPreview } from './live-preview'
import { registerPipelineIPC, shutdownPipeline } from './orchestrator'

let mainWindow: BrowserWindow | null = null

const getWindow = (): BrowserWindow | null => mainWindow

/**
 * Иконка окна и панели задач.
 *
 * Лежит рядом с исходниками, а не в dist: путь одинаково рабочий и при запуске
 * из папки проекта, и внутри asar собранного приложения. Если файла нет,
 * возвращаем undefined — Electron подставит свою, и окно всё равно откроется.
 */
function appIcon(): string | undefined {
  const file = path.join(app.getAppPath(), 'assets', 'icon.ico')
  return fs.existsSync(file) ? file : undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    icon: appIcon(),
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    title: 'AgentForge Studio',
    backgroundColor: '#1e1e1e',
    // Своя строка заголовка вместо системной: сверху остаётся ровно одна
    // полоса — наша, с меню и кнопками окна.
    frame: false,
    // Пока окно не отрисовано, показывать нечего — иначе виден белый кадр.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Нужен панели «Просмотр»: <webview> встраивает dev-сервер пользователя
      // отдельным процессом с полноценным webContents (консоль, capturePage),
      // тем же способом, каким runtime-check.ts уже поднимает скрытый
      // BrowserWindow для автоматической проверки. Риск тот же, что и у
      // прежнего <iframe> на тот же локальный адрес.
      webviewTag: true,
    },
  })

  void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // Кнопка «развернуть» в нашей строке заголовка должна менять вид
  // в том числе при разворачивании двойным щелчком или Win+Стрелка.
  const notifyMaximize = () => {
    mainWindow?.webContents.send('window:maximizedChanged', mainWindow.isMaximized())
  }
  mainWindow.on('maximize', notifyMaximize)
  mainWindow.on('unmaximize', notifyMaximize)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

function registerWindowIPC(): void {
  ipcMain.handle('window:minimize', () => getWindow()?.minimize())
  ipcMain.handle('window:toggleMaximize', () => {
    const win = getWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', () => getWindow()?.close())
  ipcMain.handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)

  // Копирование через модуль Electron, а не navigator.clipboard: страница
  // грузится по file://, и Clipboard API там доступен не всегда.
  ipcMain.handle('clipboard:write', (_e: IpcMainInvokeEvent, text: string) =>
    clipboard.writeText(text)
  )
}

function registerWorkspaceIPC(): void {
  ipcMain.handle('workspace:get', () => ({
    workspace: getWorkspaceDir(),
    data: getDataDir(),
    projectDir: getProjectDir(),
    projectName: getActiveProject().name,
  }))

  ipcMain.handle('workspace:choose', async () => {
    const win = getWindow()
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { changed: false }

    setWorkspaceDir(result.filePaths[0])
    seedWorkspace()
    refreshSystemPrompt()
    return { changed: true, workspace: getWorkspaceDir() }
  })

  // Без аргумента открывает папку активного проекта — именно она нужна
  // пользователю чаще всего.
  ipcMain.handle('workspace:reveal', (_e: IpcMainInvokeEvent, sub?: string) => {
    void shell.openPath(sub ? path.join(getProjectDir(), sub) : getProjectDir())
  })
  ipcMain.handle('workspace:revealRoot', () => void shell.openPath(getWorkspaceDir()))
}

// Одна копия приложения: вторая всё равно писала бы в те же JSON-файлы.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    seedWorkspace()
    loadPersistedKeys()

    registerWindowIPC()
    registerWorkspaceIPC()
    registerProjectsIPC()
    registerChatIPC()
    registerFileOpsIPC(getWindow)
    registerAPIIPC()
    registerDecompositionIPC()
    registerExportIPC(getWindow)
    registerTemplateIPC()
    registerMemoryIPC()
    registerMCPIPC()
    registerDeployIPC(getWindow)
    registerLivePreviewIPC()
    registerPipelineIPC(getWindow)

    // Автозапуск dev-сервера активного проекта — та же механика, что за
    // кнопкой «Старт» в «Просмотре», просто без клика. Молча, без ошибок в
    // UI: у половины проектов нет package.json или он ещё не собран, это не
    // повод показывать баннер при каждом открытии приложения — кнопка
    // «Старт» остаётся и покажет причину, если понадобится.
    void startPreview('.').catch(() => undefined)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// Dev-сервер Live Preview — дочерний процесс; без явной остановки он переживёт
// закрытие приложения и займёт порт.
app.on('before-quit', () => {
  stopPreview()
  shutdownPipeline()
})

app.on('window-all-closed', () => {
  stopPreview()
  if (process.platform !== 'darwin') app.quit()
})
