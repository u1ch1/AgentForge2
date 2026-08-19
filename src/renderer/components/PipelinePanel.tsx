import { useState } from 'react'
import type { PipelineRun, PipelineStatus, PipelineSubtask } from '../types'
import { ps, fonts, buttonPrimary, buttonDisabled, button, well } from '../theme'
import { Icon, StatusDot } from '../icons'

interface PipelinePanelProps {
  run: PipelineRun | null
  projectName: string
  onStart: (goal: string) => void
  onStop: () => void
}

const STATUS_LABEL: Record<PipelineStatus, string> = {
  idle: 'Ожидание',
  analyzing: 'Аналитик оценивает задачу…',
  awaiting_clarification: 'Аналитик ждёт уточнения',
  awaiting_analysis: 'Ждёт решения: делать или нет',
  planning: 'Admin составляет план…',
  awaiting_plan: 'План ждёт утверждения',
  working: 'Воркеры пишут код…',
  verifying: 'Проверка сборки…',
  fixing: 'Исправление ошибок…',
  done: 'Готово',
  unverified: 'Написано, но не проверено',
  failed: 'Не удалось',
  stopped: 'Остановлено',
  interrupted: 'Прервано перезапуском',
}

const ACTIVE: PipelineStatus[] = [
  'analyzing',
  'awaiting_clarification',
  'awaiting_analysis',
  'planning',
  'awaiting_plan',
  'working',
  'verifying',
  'fixing',
]

/** Стадии конвейера для визуальной дорожки — статусы группируются по тому, чья сейчас очередь. */
const STAGES: { label: string; statuses: PipelineStatus[] }[] = [
  { label: 'Analyst', statuses: ['analyzing', 'awaiting_clarification', 'awaiting_analysis'] },
  { label: 'Admin', statuses: ['planning', 'awaiting_plan'] },
  { label: 'Воркеры', statuses: ['working'] },
  { label: 'Тестер', statuses: ['verifying', 'fixing'] },
  { label: 'Готово', statuses: ['done', 'unverified', 'failed', 'stopped', 'interrupted'] },
]

function stageIndex(status: PipelineStatus): number {
  const idx = STAGES.findIndex((s) => s.statuses.includes(status))
  return idx === -1 ? 0 : idx
}

function StageTracker({ status }: { status: PipelineStatus }) {
  const current = stageIndex(status)
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginTop: '7px' }}>
      {STAGES.map((stage, i) => {
        const isCurrent = i === current
        const isPast = i < current
        const color = isCurrent ? statusColor(status) : isPast ? ps.ok : ps.textFaint
        return (
          <div key={stage.label} style={{ display: 'flex', alignItems: 'center', flex: i < STAGES.length - 1 ? 1 : undefined }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: '9px', color, whiteSpace: 'nowrap' }}>{stage.label}</span>
            </div>
            {i < STAGES.length - 1 && (
              <div style={{ flex: 1, height: '1px', background: isPast ? ps.ok : ps.borderDark, margin: '0 4px 12px' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function statusColor(status: PipelineStatus): string {
  if (status === 'done') return ps.ok
  if (status === 'failed') return ps.err
  if (status === 'stopped' || status === 'unverified' || status === 'interrupted') return ps.warn
  return ps.info
}

function subtaskColor(status: PipelineSubtask['status']): string {
  return {
    pending: ps.textFaint,
    in_progress: ps.info,
    done: ps.ok,
    failed: ps.err,
  }[status]
}

const AGENT_LABEL: Record<string, string> = {
  analyst: 'Analyst',
  admin: 'Admin',
  frontend: 'Worker1',
  backend: 'Worker2',
  tester: 'Tester',
}

/**
 * Панель конвейера: закинуть задачу и следить, как она превращается в проект.
 * Единственная точка вмешательства — утверждение плана, оно приходит отдельным
 * окном; здесь остаются запуск, прогресс и журнал.
 */
export default function PipelinePanel({ run, projectName, onStart, onStop }: PipelinePanelProps) {
  const [goal, setGoal] = useState('')
  const busy = run !== null && ACTIVE.includes(run.status)

  if (!busy) {
    return (
      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {run && (
          <div
            style={{
              ...well,
              padding: '7px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
              <StatusDot color={statusColor(run.status)} />
              <span style={{ color: statusColor(run.status) }}>{STATUS_LABEL[run.status]}</span>
            </div>
            <div style={{ fontSize: '10px', color: ps.textDim, lineHeight: 1.5 }}>{run.goal}</div>
            {run.checks && (
              <div
                style={{
                  fontSize: '10px',
                  color: !run.checks.ran ? ps.warn : run.checks.passed ? ps.ok : ps.err,
                }}
              >
                {!run.checks.ran
                  ? 'Проверять нечем: нет ни сборки, ни тестов'
                  : `Сборка: ${run.checks.passed ? 'проходит' : 'падает'}`}
              </div>
            )}
            {run.runtime && run.runtime.ran && (
              <div style={{ fontSize: '10px', color: run.runtime.ok ? ps.ok : ps.err }}>
                Запуск приложения: {run.runtime.ok ? 'отвечает, замечаний нет' : 'есть замечания'}
              </div>
            )}
            {run.design && (
              <div
                style={{
                  fontSize: '10px',
                  color:
                    run.design.after === null
                      ? ps.textDim
                      : run.design.after < run.design.before
                        ? ps.ok
                        : ps.warn,
                }}
              >
                {run.design.after === null
                  ? run.design.before === 0
                    ? 'Оформление: замечаний нет'
                    : `Оформление: замечаний ${run.design.before}, дизайнер не правил`
                  : `Оформление: было ${run.design.before}, стало ${run.design.after}`}
              </div>
            )}
            {run.screenshot && <Preview path={run.screenshot} />}
            {run.review && run.review.critical.length > 0 && (
              <div style={{ fontSize: '10px', color: ps.err, lineHeight: 1.5 }}>
                Тестер: критических замечаний {run.review.critical.length}
                {run.review.critical.map((c, i) => (
                  <div key={i} style={{ color: ps.textDim }}>
                    {c}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ fontSize: '10px', color: ps.textDim, lineHeight: 1.6 }}>
          Опиши задачу целиком — как заказчик. Admin разобьёт её на подзадачи, ты утвердишь
          план, дальше воркеры и тестер работают сами в папке проекта «{projectName}».
        </div>

        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={7}
          placeholder="Например: Telegram-бот для записи на стрижку с админкой на FastAPI и SQLite. Клиент выбирает мастера и время, админ видит расписание."
          style={{
            width: '100%',
            padding: '6px 7px',
            border: `1px solid ${ps.borderInput}`,
            borderRadius: '2px',
            background: ps.sunken,
            color: ps.textStrong,
            fontSize: '11px',
            fontFamily: fonts.ui,
            lineHeight: 1.55,
            resize: 'vertical',
          }}
        />
        <button
          onClick={() => {
            if (goal.trim()) onStart(goal.trim())
          }}
          disabled={!goal.trim()}
          style={goal.trim() ? buttonPrimary : buttonDisabled}
        >
          <Icon name="play" size={12} />
          Запустить конвейер
        </button>

        {run && run.log.length > 0 && <LogView run={run} />}

        <RunHistory />
      </div>
    )
  }

  const done = run.subtasks.filter((s) => s.status === 'done').length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '9px 10px', borderBottom: `1px solid ${ps.border}` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            color: statusColor(run.status),
          }}
        >
          <StatusDot color={statusColor(run.status)} />
          {STATUS_LABEL[run.status]}
        </div>
        <StageTracker status={run.status} />
        {run.subtasks.length > 0 && (
          <div style={{ fontSize: '10px', color: ps.textFaint, marginTop: '3px' }}>
            Подзадач: {done} из {run.subtasks.length}
            {run.fixAttempts > 0 && ` · правок: ${run.fixAttempts}`}
          </div>
        )}
      </div>

      {run.screenshot && (
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${ps.border}`, flexShrink: 0 }}>
          <Preview path={run.screenshot} />
          {run.screenshotHistory.length > 1 && (
            <div style={{ display: 'flex', gap: '3px', marginTop: '5px' }}>
              {run.screenshotHistory.map((p) => (
                <Thumbnail key={p} path={p} />
              ))}
            </div>
          )}
        </div>
      )}

      {run.subtasks.length > 0 && (
        <div style={{ maxHeight: '38%', overflowY: 'auto', flexShrink: 0 }}>
          {run.subtasks.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'flex',
                gap: '6px',
                padding: '5px 10px',
                borderBottom: `1px solid ${ps.border}`,
              }}
            >
              <span style={{ marginTop: '4px' }}>
                <StatusDot color={subtaskColor(s.status)} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '11px', color: ps.text, lineHeight: 1.4 }}>{s.title}</div>
                <div style={{ fontSize: '10px', color: ps.textFaint }}>
                  {AGENT_LABEL[s.assignee]}
                  {s.files.length > 0 && ` · файлов: ${s.files.length}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <LogView run={run} grow />

      <div style={{ padding: '8px 10px', borderTop: `1px solid ${ps.border}` }}>
        <button onClick={onStop} style={{ ...button, width: '100%', color: ps.err }}>
          <Icon name="stop" size={11} />
          Остановить
        </button>
      </div>
    </div>
  )
}

/**
 * Снимок готовой страницы.
 *
 * Файл лежит в данных приложения, а renderer работает по file://, поэтому
 * картинка подключается напрямую по файловому адресу — без IPC и без копии в
 * памяти. Путь к снимку меняется вместе с прогоном, поэтому к адресу добавлена
 * метка времени: иначе браузер показал бы снимок предыдущего прогона из кэша.
 */
function Preview({ path }: { path: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null

  const url = `file:///${path.replace(/\\/g, '/')}?t=${Date.now()}`
  return (
    <div style={{ marginTop: '4px' }}>
      <div style={{ fontSize: '10px', color: ps.textFaint, marginBottom: '3px' }}>
        Как выглядит готовая страница
      </div>
      <img
        src={url}
        alt="Снимок готовой страницы"
        onError={() => setFailed(true)}
        style={{
          width: '100%',
          display: 'block',
          border: `1px solid ${ps.border}`,
          borderRadius: '2px',
          background: ps.sunken,
        }}
      />
    </div>
  )
}

/** Кадр мини-истории — та же механика, что у Preview, но без подписи и мельче. */
function Thumbnail({ path }: { path: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null

  const url = `file:///${path.replace(/\\/g, '/')}?t=${Date.now()}`
  return (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      style={{
        height: '36px',
        flex: 1,
        minWidth: 0,
        objectFit: 'cover',
        display: 'block',
        border: `1px solid ${ps.borderDark}`,
        borderRadius: '2px',
        background: ps.sunken,
      }}
    />
  )
}

function LogView({ run, grow }: { run: PipelineRun; grow?: boolean }) {
  const color = (kind: string) => (kind === 'ok' ? ps.ok : kind === 'err' ? ps.err : ps.textDim)
  return (
    <div
      style={{
        flex: grow ? 1 : undefined,
        minHeight: 0,
        maxHeight: grow ? undefined : '180px',
        overflowY: 'auto',
        padding: '6px 10px',
        fontFamily: fonts.mono,
        fontSize: '10px',
        lineHeight: 1.6,
        background: grow ? ps.sunken : undefined,
        ...(grow ? {} : well),
      }}
    >
      {run.log.map((e, i) => (
        <div key={i} style={{ color: color(e.kind), wordBreak: 'break-word' }}>
          {e.agent ? `[${AGENT_LABEL[e.agent] ?? e.agent}] ` : ''}
          {e.text}
        </div>
      ))}
    </div>
  )
}

/**
 * Прошлые прогоны этого проекта — `pipeline.json` хранит только последний,
 * а прежние решения Analyst, планы Admin и логи иначе исчезали бы бесследно
 * при каждом новом запуске конвейера на том же проекте.
 */
function RunHistory() {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<PipelineRun[] | null>(null)
  const [selected, setSelected] = useState<PipelineRun | null>(null)

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && history === null) setHistory(await window.electronAPI.pipelineGetHistory())
  }

  return (
    <div style={{ marginTop: '4px' }}>
      <button onClick={() => void toggle()} style={{ ...button, fontSize: '10px' }}>
        <Icon name="tree" size={11} />
        История прогонов{history && history.length > 0 ? ` (${history.length})` : ''}
      </button>

      {open && (
        <div style={{ ...well, marginTop: '5px', maxHeight: '160px', overflowY: 'auto' }}>
          {history === null ? (
            <div style={{ padding: '8px', fontSize: '10px', color: ps.textFaint }}>Загрузка…</div>
          ) : history.length === 0 ? (
            <div style={{ padding: '8px', fontSize: '10px', color: ps.textFaint }}>
              Прошлых прогонов ещё нет — появятся после первого завершённого.
            </div>
          ) : (
            [...history].reverse().map((r) => (
              <div
                key={r.id}
                onClick={() => setSelected(r)}
                style={{
                  padding: '6px 8px',
                  borderBottom: `1px solid ${ps.border}`,
                  cursor: 'pointer',
                  background: selected?.id === r.id ? ps.active : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px' }}>
                  <StatusDot color={statusColor(r.status)} />
                  <span style={{ color: statusColor(r.status) }}>{STATUS_LABEL[r.status]}</span>
                  <span style={{ color: ps.textFaint, marginLeft: 'auto' }}>
                    {new Date(r.startedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div style={{ fontSize: '10px', color: ps.textDim, marginTop: '2px' }}>
                  {r.goal.length > 90 ? r.goal.slice(0, 90) + '…' : r.goal}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {selected && (
        <div style={{ marginTop: '5px' }}>
          <div style={{ fontSize: '10px', color: ps.textFaint, marginBottom: '3px' }}>
            Лог прогона от {new Date(selected.startedAt).toLocaleString('ru-RU')}
          </div>
          <LogView run={selected} />
        </div>
      )}
    </div>
  )
}
