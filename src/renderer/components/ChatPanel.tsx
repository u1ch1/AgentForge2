import { useRef, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Agent, AppSettings, Message } from '../types'
import { agentIcon, isCodeOnlyAgent } from '../types'
import { ps, fonts, button, buttonPrimary, buttonDisabled } from '../theme'
import { Icon, IconFilled, type IconName } from '../icons'
import { Markdown, CodeBlock } from '../markdown'
import { parseCodeBlocks } from '../../shared/code-blocks'
import ChatSettingsMenu from './ChatSettingsMenu'

interface ChatPanelProps {
  agent: Agent | undefined
  projectName: string
  messages: Message[]
  streamingText: string
  isStreaming: boolean
  inputValue: string
  onInputChange: (val: string) => void
  onSend: () => void
  onStop: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  error: string | null
  onDismissError: () => void
  settings: AppSettings
  onUpdateSettings: (patch: Partial<AppSettings>) => void
  onEditMessage: (messageId: string, newText: string) => void
  onRegenerate: () => void
  onDeleteMessage: (messageId: string) => void
  onClearChat: () => void
}

const FONT_PX: Record<AppSettings['chatFontSize'], number> = { small: 11, medium: 12, large: 13.5 }

/** Сколько последних сообщений рендерим сразу; более ранние — по кнопке. */
const DEFAULT_RENDER_LIMIT = 200
const RENDER_LIMIT_STEP = 200

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function metaFor(msg: Message, isUser: boolean, settings: AppSettings): string {
  const bits: string[] = []
  if (settings.chatShowTimestamps) bits.push(timeOf(msg.timestamp))
  if (!isUser && settings.chatShowModelBadge && msg.model) bits.push(msg.model)
  return bits.join(' · ')
}

/** Кнопка копирования всего сообщения — появляется при наведении на строку. */
function CopyButton({ text, visible }: { text: string; visible: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        await window.electronAPI.copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
      title="Скопировать сообщение целиком"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        height: '16px',
        padding: '0 5px',
        border: 'none',
        borderRadius: '2px',
        background: 'transparent',
        color: copied ? ps.ok : ps.textFaint,
        fontSize: '10px',
        cursor: 'pointer',
        opacity: visible || copied ? 1 : 0,
        transition: 'opacity 0.12s',
      }}
      onMouseOver={(e) => (e.currentTarget.style.background = ps.hover)}
      onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon name={copied ? 'check' : 'doc'} size={11} />
      {copied ? 'Скопировано' : 'Копировать'}
    </button>
  )
}

/** Действие над сообщением (изменить / повторить / удалить) — та же геометрия, что у CopyButton. */
function ActionButton({
  icon,
  label,
  onClick,
  visible,
  danger,
}: {
  icon: IconName
  label: string
  onClick: () => void
  visible: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        height: '16px',
        padding: '0 5px',
        border: 'none',
        borderRadius: '2px',
        background: 'transparent',
        color: danger ? '#c07a7a' : ps.textFaint,
        fontSize: '10px',
        cursor: 'pointer',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.12s',
      }}
      onMouseOver={(e) => (e.currentTarget.style.background = danger ? '#4a2c2c' : ps.hover)}
      onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  )
}

/** Плавающая кнопка «вниз» — появляется, когда пользователь прокрутил вверх. */
function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="К последнему сообщению"
      style={{
        position: 'absolute',
        bottom: '12px',
        right: '16px',
        width: '30px',
        height: '30px',
        borderRadius: '50%',
        border: `1px solid ${ps.borderLight}`,
        background: '#3d3d3d',
        color: ps.textStrong,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      }}
      onMouseOver={(e) => (e.currentTarget.style.background = ps.hover)}
      onMouseOut={(e) => (e.currentTarget.style.background = '#3d3d3d')}
    >
      <Icon name="chevronDown" size={14} />
    </button>
  )
}

const messageEditStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: `1px solid ${ps.accent}`,
  borderRadius: '2px',
  background: ps.sunken,
  color: ps.textStrong,
  fontSize: '12px',
  fontFamily: fonts.ui,
  lineHeight: 1.5,
  resize: 'none',
}

/**
 * «Холст» приложения. Сообщения — строки журнала во всю ширину: заголовок
 * с автором и моделью, ниже разобранный Markdown. Текст выделяется мышью,
 * у каждого сообщения есть копирование; у пользовательских — правка,
 * у последнего ответа агента — повтор генерации; удаление — у всех.
 */
export default function ChatPanel({
  agent,
  projectName,
  messages,
  streamingText,
  isStreaming,
  inputValue,
  onInputChange,
  onSend,
  onStop,
  onKeyDown,
  error,
  onDismissError,
  settings,
  onUpdateSettings,
  onEditMessage,
  onRegenerate,
  onDeleteMessage,
  onClearChat,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [hovered, setHovered] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  // Worker1/Worker2: чат — лента кода, без промптов от Admin и без прозы вокруг него.
  const codeOnly = agent ? isCodeOnlyAgent(agent.id) : false
  const visibleMessages = codeOnly ? messages.filter((m) => m.sender === 'agent') : messages

  // Долгий диалог (конвейер пишет много) не рендерим целиком — только хвост,
  // а раньше показываем по запросу. Иначе прокрутка тяжёлого DOM-дерева
  // начинает подтормаживать на давних проектах.
  const [renderLimit, setRenderLimit] = useState(DEFAULT_RENDER_LIMIT)
  useEffect(() => setRenderLimit(DEFAULT_RENDER_LIMIT), [agent?.id])
  const hiddenCount = Math.max(0, visibleMessages.length - renderLimit)
  const shownMessages = hiddenCount > 0 ? visibleMessages.slice(hiddenCount) : visibleMessages

  const evaluateBottom = () => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const onScroll = () => {
    const bottom = evaluateBottom()
    stick.current = bottom
    setAtBottom(bottom)
  }

  useEffect(() => {
    if (scrollRef.current && stick.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    setAtBottom(evaluateBottom())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, streamingText])

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stick.current = true
    setAtBottom(true)
  }

  const startEdit = (msg: Message) => {
    setEditingId(msg.id)
    setEditDraft(msg.text)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditDraft('')
  }
  const saveEdit = () => {
    const text = editDraft.trim()
    if (!text || !editingId) return
    onEditMessage(editingId, text)
    setEditingId(null)
    setEditDraft('')
  }

  const fontPx = FONT_PX[settings.chatFontSize]
  const contentWidth: CSSProperties =
    settings.chatWidth === 'comfortable' ? { maxWidth: '760px', margin: '0 auto' } : {}

  const header = (who: string, isUser: boolean, meta: string, right?: ReactNode) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '4px',
        fontSize: '10px',
        letterSpacing: '0.4px',
        textTransform: 'uppercase',
        color: isUser ? ps.info : ps.accentHover,
      }}
    >
      {!isUser && <Icon name={agent ? agentIcon(agent.icon) : 'move'} size={12} />}
      <span>{who}</span>
      {meta && <span style={{ color: ps.textFaint, textTransform: 'none' }}>{meta}</span>}
      <span style={{ flex: 1 }} />
      {right}
    </div>
  )

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Строка инструментов чата — счётчик, настройки вида, очистка диалога. */}
      <div
        style={{
          height: '26px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '0 8px 0 12px',
          background: ps.panelHeader,
          borderBottom: `1px solid ${ps.borderDark}`,
          fontSize: '10px',
          color: ps.textFaint,
        }}
      >
        <span>
          {visibleMessages.length > 0 ? `${visibleMessages.length} сообщ. в диалоге` : 'Новый диалог'}
        </span>
        <div style={{ flex: 1 }} />

        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowSettings((v) => !v)}
            title="Настройки чата"
            style={{
              width: '22px',
              height: '22px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              borderRadius: '2px',
              background: showSettings ? ps.active : 'transparent',
              color: ps.textDim,
              cursor: 'pointer',
              padding: 0,
            }}
            onMouseOver={(e) => {
              if (!showSettings) e.currentTarget.style.background = ps.hover
            }}
            onMouseOut={(e) => {
              if (!showSettings) e.currentTarget.style.background = 'transparent'
            }}
          >
            <Icon name="sliders" size={13} />
          </button>
          {showSettings && (
            <ChatSettingsMenu
              settings={settings}
              onChange={onUpdateSettings}
              onClose={() => setShowSettings(false)}
            />
          )}
        </div>

        <button
          onClick={onClearChat}
          disabled={messages.length === 0}
          title="Очистить диалог"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            height: '22px',
            padding: '0 7px',
            border: 'none',
            borderRadius: '2px',
            background: 'transparent',
            color: messages.length === 0 ? ps.textDisabled : ps.textDim,
            fontSize: '10px',
            cursor: messages.length === 0 ? 'default' : 'pointer',
          }}
          onMouseOver={(e) => {
            if (messages.length) e.currentTarget.style.background = ps.hover
          }}
          onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="trash" size={11} />
          Очистить
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ height: '100%', overflowY: 'auto', padding: '4px 0' }}
        >
          {visibleMessages.length === 0 && !isStreaming ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: ps.textFaint,
                gap: '10px',
                padding: '0 24px',
                textAlign: 'center',
              }}
            >
              <Icon name={agent ? agentIcon(agent.icon) : 'move'} size={44} strokeWidth={0.8} />
              <div style={{ fontSize: '11px' }}>
                {agent ? `${agent.name} — ${agent.role}` : 'Агент не выбран'}
              </div>
              <div style={{ fontSize: '10px', color: ps.textDisabled, lineHeight: 1.6 }}>
                Отдельный диалог для проекта «{projectName}».
                <br />
                Enter — отправить, Shift+Enter — новая строка.
              </div>
            </div>
          ) : (
            <div style={contentWidth}>
              {hiddenCount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 10px' }}>
                  <button
                    onClick={() => setRenderLimit((n) => n + RENDER_LIMIT_STEP)}
                    style={{ ...button, fontSize: '10px' }}
                  >
                    Показать более раннюю историю (+{Math.min(hiddenCount, RENDER_LIMIT_STEP)})
                  </button>
                </div>
              )}
              {shownMessages.map((msg, i) => {
                const isUser = msg.sender === 'user'
                const isLast = i === shownMessages.length - 1
                const rowVisible = hovered === msg.id || (isLast && !isStreaming)
                const isEditing = editingId === msg.id
                const hasFollowing = i < shownMessages.length - 1
                const pathBlocks = codeOnly && !isUser ? parseCodeBlocks(msg.text).filter((b) => b.path) : []

                return (
                  <div
                    key={msg.id}
                    onMouseEnter={() => setHovered(msg.id)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      padding: '9px 14px',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                      borderLeft: `2px solid ${isUser ? ps.info : ps.accent}`,
                    }}
                  >
                    {header(
                      isUser ? 'Вы' : (agent?.name ?? 'Агент'),
                      isUser,
                      metaFor(msg, isUser, settings),
                      !isEditing && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                          <CopyButton text={msg.text} visible={rowVisible} />
                          {isUser && !isStreaming && (
                            <ActionButton
                              icon="pencil"
                              label="Изменить"
                              onClick={() => startEdit(msg)}
                              visible={rowVisible}
                            />
                          )}
                          {!isUser && isLast && !isStreaming && (
                            <ActionButton
                              icon="refresh"
                              label="Повторить"
                              onClick={onRegenerate}
                              visible={rowVisible}
                            />
                          )}
                          <ActionButton
                            icon="trash"
                            label="Удалить"
                            danger
                            onClick={() => onDeleteMessage(msg.id)}
                            visible={rowVisible}
                          />
                        </div>
                      )
                    )}

                    {isEditing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              saveEdit()
                            }
                            if (e.key === 'Escape') cancelEdit()
                          }}
                          autoFocus
                          rows={3}
                          style={messageEditStyle}
                        />
                        <div style={{ fontSize: '10px', color: ps.textFaint }}>
                          {hasFollowing
                            ? 'Сообщения после этого будут удалены, ответ будет сгенерирован заново.'
                            : 'Ответ будет сгенерирован заново.'}
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button onClick={saveEdit} style={buttonPrimary}>
                            Сохранить и повторить
                          </button>
                          <button onClick={cancelEdit} style={button}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        data-selectable="true"
                        style={{
                          fontSize: `${fontPx}px`,
                          color: ps.text,
                          wordBreak: 'break-word',
                          fontFamily: fonts.ui,
                          userSelect: 'text',
                          cursor: 'text',
                        }}
                      >
                        {/* Запрос пользователя показываем как есть: он его сам набрал,
                            разметку в нём разбирать незачем. */}
                        {isUser ? (
                          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{msg.text}</div>
                        ) : pathBlocks.length > 0 ? (
                          // Worker1/Worker2: только код, уже сохранённый в файлы проекта — без прозы.
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            {pathBlocks.map((b, bi) => (
                              <CodeBlock key={bi} code={b.code} lang={b.lang} path={b.path} />
                            ))}
                          </div>
                        ) : (
                          <Markdown text={msg.text} />
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {isStreaming && (
                <div style={{ padding: '9px 14px', borderLeft: `2px solid ${ps.accent}` }}>
                  {header(agent?.name ?? 'Агент', false, 'генерация…')}
                  <div
                    data-selectable="true"
                    style={{
                      fontSize: `${fontPx}px`,
                      color: ps.text,
                      wordBreak: 'break-word',
                      userSelect: 'text',
                    }}
                  >
                    <Markdown text={streamingText} />
                    <span className="caret">▌</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {!atBottom && <ScrollToBottomButton onClick={scrollToBottom} />}
      </div>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '7px',
            padding: '7px 12px',
            background: '#2a1f1f',
            borderTop: `1px solid ${ps.borderDark}`,
            borderLeft: `3px solid ${ps.err}`,
            color: '#e08d8d',
            fontSize: '11px',
            flexShrink: 0,
          }}
        >
          <span style={{ marginTop: '1px' }}>
            <Icon name="alert" size={13} />
          </span>
          <span style={{ flex: 1, lineHeight: 1.5, userSelect: 'text' }}>{error}</span>
          <button
            onClick={onDismissError}
            style={{
              background: 'none',
              border: 'none',
              color: ps.textDim,
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
            }}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      <div
        style={{
          borderTop: `1px solid ${ps.borderDark}`,
          background: ps.panel,
          padding: '8px 10px',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', ...contentWidth }}>
          <textarea
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Запрос к ${agent?.name ?? 'агенту'} по проекту «${projectName}»…`}
            rows={3}
            style={{
              flex: 1,
              padding: '6px 8px',
              border: `1px solid ${ps.borderInput}`,
              borderRadius: '2px',
              background: ps.sunken,
              color: ps.textStrong,
              fontSize: '12px',
              fontFamily: fonts.ui,
              lineHeight: 1.5,
              resize: 'none',
              minHeight: '58px',
              maxHeight: '190px',
            }}
          />
          {isStreaming ? (
            <button onClick={onStop} style={{ ...button, color: ps.err, height: '26px' }}>
              <IconFilled name="stop" size={11} />
              Стоп
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!inputValue.trim()}
              style={
                inputValue.trim()
                  ? { ...buttonPrimary, height: '26px' }
                  : { ...buttonDisabled, height: '26px' }
              }
            >
              <Icon name="send" size={12} />
              Отправить
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
