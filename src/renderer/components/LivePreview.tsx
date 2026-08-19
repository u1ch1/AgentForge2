import { useState, useEffect, useRef } from 'react'
import type { ConsoleMessageEvent, WebviewTag } from 'electron'
import { ps, fonts, input, button, buttonPrimary, notice, well } from '../theme'
import { Icon, IconFilled } from '../icons'
import type { PreviewCheckResult } from '../types'

interface LivePreviewProps {
  /** Пока конвейер занят, ручную проверку не запускаем — второй npm start по тому же проекту лишний. */
  pipelineBusy: boolean
}

const CONSOLE_LEVEL_KIND: Record<number, 'info' | 'warn' | 'err'> = { 0: 'info', 1: 'info', 2: 'warn', 3: 'err' }
const MAX_CONSOLE_LINES = 100

export default function LivePreview({ pipelineBusy }: LivePreviewProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Конвейер кладёт проект в корень папки, а не в frontend/ — это раскладка
  // из старых шаблонов. Поле остаётся редактируемым для таких проектов.
  const [projectPath, setProjectPath] = useState('.')
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const webviewRef = useRef<HTMLWebViewElement>(null)

  const [consoleLines, setConsoleLines] = useState<{ level: number; message: string }[]>([])
  const [showConsole, setShowConsole] = useState(false)

  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<PreviewCheckResult | null>(null)

  useEffect(() => {
    const check = async () => {
      const res = await window.electronAPI.previewGetUrl()
      setUrl(res.url)
      setIsRunning(Boolean(res.url))
      if (showLogs) setLogs((await window.electronAPI.previewGetLogs()).logs)
    }
    void check()
    const t = setInterval(() => void check(), 4000)
    return () => clearInterval(t)
  }, [showLogs])

  // <webview> — отдельный процесс рендеринга с полноценным webContents: тем
  // же способом runtime-check.ts уже читает консоль скрытого окна на стадии
  // Тестера, здесь то же самое, но видимо и интерактивно.
  useEffect(() => {
    // @types/react знает <webview> только как пустой HTMLElement — реальный
    // тег даёт Electron, и его типы приходится подключать явным приведением.
    const el = webviewRef.current as unknown as WebviewTag | null
    if (!el || !isRunning) return

    const onConsole = (e: ConsoleMessageEvent) => {
      setConsoleLines((prev) => [...prev.slice(-(MAX_CONSOLE_LINES - 1)), { level: e.level, message: e.message }])
    }
    el.addEventListener('console-message', onConsole)
    return () => {
      el.removeEventListener('console-message', onConsole)
    }
  }, [isRunning, url])

  const start = async () => {
    setError(null)
    setStarting(true)
    setConsoleLines([])
    try {
      const res = await window.electronAPI.previewStart(projectPath)
      if (res.success && res.url) {
        setUrl(res.url)
        setIsRunning(true)
      } else {
        setError(res.error || 'Не удалось запустить dev-сервер')
        setLogs((await window.electronAPI.previewGetLogs()).logs)
        setShowLogs(true)
      }
    } finally {
      setStarting(false)
    }
  }

  const runChecks = async () => {
    setChecking(true)
    setCheckResult(null)
    try {
      setCheckResult(await window.electronAPI.previewRunChecks())
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: '4px', padding: '8px' }}>
        <input
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          placeholder="папка с package.json — «.» это корень проекта"
          disabled={isRunning}
          style={{ ...input, flex: 1, fontFamily: fonts.mono, opacity: isRunning ? 0.55 : 1 }}
        />
        {!isRunning ? (
          <button
            onClick={() => void start()}
            disabled={starting}
            style={starting ? { ...button, opacity: 0.6, cursor: 'wait' } : buttonPrimary}
          >
            <Icon name="play" size={11} />
            {starting ? 'Запуск…' : 'Старт'}
          </button>
        ) : (
          <>
            <button
              onClick={() => (webviewRef.current as unknown as WebviewTag | null)?.reload()}
              style={{ ...button, width: '24px', padding: 0 }}
              title="Перезагрузить"
            >
              <Icon name="refresh" size={12} />
            </button>
            <button
              onClick={() => void window.electronAPI.previewOpenWindow()}
              style={{ ...button, width: '24px', padding: 0 }}
              title="Развернуть в отдельном окне"
            >
              <Icon name="external" size={12} />
            </button>
            <button
              onClick={async () => {
                await window.electronAPI.previewStop()
                setUrl(null)
                setIsRunning(false)
              }}
              style={{ ...button, color: ps.err }}
            >
              <IconFilled name="stop" size={10} />
              Стоп
            </button>
          </>
        )}
      </div>

      {error && (
        <div style={{ margin: '0 8px 8px' }}>
          <div style={notice('err')}>{error}</div>
        </div>
      )}

      {isRunning && url ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 8px 6px',
              fontSize: '10px',
            }}
          >
            <span style={{ color: ps.ok, display: 'flex' }}>
              <Icon name="link" size={12} />
            </span>
            <span style={{ color: ps.textDim, flex: 1, fontFamily: fonts.mono }}>{url}</span>
            <button
              onClick={() => setShowConsole((v) => !v)}
              style={{
                border: 'none',
                background: 'transparent',
                color: ps.textFaint,
                fontSize: '10px',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {showConsole ? 'скрыть консоль' : `консоль${consoleLines.length ? ` (${consoleLines.length})` : ''}`}
            </button>
            <button
              onClick={() => setShowLogs((v) => !v)}
              style={{
                border: 'none',
                background: 'transparent',
                color: ps.textFaint,
                fontSize: '10px',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {showLogs ? 'скрыть лог' : 'лог'}
            </button>
          </div>
          <webview
            ref={webviewRef}
            src={url}
            // Явно, а не по умолчанию — той же строкой, какой в runtime-check.ts
            // уже описан скрытый BrowserWindow (nodeIntegration:false,
            // contextIsolation:true). allowpopups не указан — по умолчанию
            // выключен, окна-попапы из dev-сервера открываться не будут.
            webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
            style={{
              flex: 1,
              width: '100%',
              margin: '0 8px',
              border: `1px solid ${ps.borderDark}`,
              background: '#fff',
              minHeight: '220px',
            }}
          />
        </>
      ) : (
        !error && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              color: ps.textFaint,
              padding: '0 16px',
              textAlign: 'center',
            }}
          >
            <Icon name="eye" size={32} strokeWidth={0.9} />
            <div style={{ fontSize: '11px', lineHeight: 1.6 }}>
              Запускает <span style={{ color: ps.textDim }}>npm run dev</span> в указанной папке
              и показывает результат здесь
            </div>
          </div>
        )
      )}

      {showConsole && (
        <div
          style={{
            ...well,
            margin: '8px',
            maxHeight: '150px',
            overflow: 'auto',
            padding: '6px 8px',
            fontSize: '10px',
            fontFamily: fonts.mono,
            lineHeight: 1.6,
          }}
        >
          {consoleLines.length === 0
            ? <span style={{ color: ps.textFaint }}>Консоль пуста</span>
            : consoleLines.map((c, i) => (
                <div key={i} style={{ color: ps[CONSOLE_LEVEL_KIND[c.level] ?? 'info'], wordBreak: 'break-word' }}>
                  {c.message}
                </div>
              ))}
        </div>
      )}

      {showLogs && (
        <pre
          style={{
            ...well,
            margin: '8px',
            maxHeight: '150px',
            overflow: 'auto',
            padding: '6px 8px',
            fontSize: '10px',
            fontFamily: fonts.mono,
            color: ps.textDim,
            whiteSpace: 'pre-wrap',
            lineHeight: 1.5,
          }}
        >
          {logs.length ? logs.join('\n') : 'Лог пуст'}
        </pre>
      )}

      <div style={{ borderTop: `1px solid ${ps.border}`, padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <button
          onClick={() => void runChecks()}
          disabled={checking || pipelineBusy}
          title={pipelineBusy ? 'Конвейер занят — дождитесь его или остановите' : undefined}
          style={checking || pipelineBusy ? { ...button, opacity: 0.55, cursor: 'not-allowed' } : button}
        >
          <Icon name="bug" size={11} />
          {checking ? 'Проверяю…' : 'Прогнать проверки сейчас'}
        </button>
        <div style={{ fontSize: '10px', color: ps.textFaint, lineHeight: 1.5 }}>
          Отдельно от конвейера: поднимает активный проект своей командой (
          <span style={{ fontFamily: fonts.mono }}>npm start</span>) и стучится в него — без сценария и
          дизайнера, это чисто механическая проверка, агентов не трогает.
        </div>

        {checkResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <div style={notice(checkResult.ran ? (checkResult.ok ? 'ok' : 'err') : 'warn')}>
              {checkResult.summary}
            </div>
            {checkResult.findings.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                {checkResult.findings.map((f, i) => (
                  <div key={i} style={{ fontSize: '10px', color: f.severity === 'hard' ? ps.err : ps.warn, lineHeight: 1.5 }}>
                    [{f.severity === 'hard' ? 'БЛОКЕР' : 'замечание'}] {f.text}
                  </div>
                ))}
              </div>
            )}
            {checkResult.screenshot && <ManualScreenshot path={checkResult.screenshot} />}
          </div>
        )}
      </div>
    </div>
  )
}

/** Снимок ручной проверки — тот же принцип, что у превью в панели конвейера: файл перечитывается по метке времени. */
function ManualScreenshot({ path }: { path: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null

  const src = `file:///${path.replace(/\\/g, '/')}?t=${Date.now()}`
  return (
    <img
      src={src}
      alt="Снимок страницы"
      onError={() => setFailed(true)}
      style={{
        width: '100%',
        display: 'block',
        border: `1px solid ${ps.border}`,
        borderRadius: '2px',
        background: ps.sunken,
      }}
    />
  )
}
