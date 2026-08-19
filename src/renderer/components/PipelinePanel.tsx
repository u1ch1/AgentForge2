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
        {run.subtasks.length > 0 && (
          <div style={{ fontSize: '10px', color: ps.textFaint, marginTop: '3px' }}>
            Подзадач: {done} из {run.subtasks.length}
            {run.fixAttempts > 0 && ` · правок: ${run.fixAttempts}`}
          </div>
        )}
      </div>

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
