import { useState, useEffect } from 'react'
import type { PipelineRun, PipelineSubtask } from '../types'
import { ps, fonts, input, button, buttonPrimary, well } from '../theme'
import { Icon } from '../icons'

interface PlanApprovalProps {
  run: PipelineRun
  onApprove: (subtasks: PipelineSubtask[]) => void
  onCancel: () => void
}

const ASSIGNEES: { id: 'frontend' | 'backend'; label: string }[] = [
  { id: 'frontend', label: 'Worker1 · Frontend' },
  { id: 'backend', label: 'Worker2 · Backend' },
]

interface AgentUsage {
  cost: number
  messageCount: number
}

/** Пока по этому исполнителю нет истории расхода — грубый ориентир, чтобы цифра не была пустой. */
const FALLBACK_COST_PER_SUBTASK = 0.05

/** Средний расход на один вызов агента — по его же прошлым сообщениям в этой сессии. */
function averageCost(agents: Record<string, AgentUsage>, agentId: string): number | null {
  const u = agents[agentId]
  return u && u.messageCount > 0 ? u.cost / u.messageCount : null
}

/**
 * Единственная остановка конвейера. Ошибка в плане стоит одного запроса,
 * ошибка в коде по кривому плану — десятка файлов и прогона сборки, поэтому
 * править дешевле здесь.
 */
export default function PlanApproval({ run, onApprove, onCancel }: PlanApprovalProps) {
  const [items, setItems] = useState<PipelineSubtask[]>(run.subtasks)
  const [estimate, setEstimate] = useState<{ value: number; roughly: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const session = await window.electronAPI.getSessionUsage()
      const avgFrontend = averageCost(session.agents, 'frontend')
      const avgBackend = averageCost(session.agents, 'backend')
      let value = 0
      let roughly = false
      for (const s of items) {
        const avg = s.assignee === 'frontend' ? avgFrontend : avgBackend
        if (avg === null) {
          roughly = true
          value += FALLBACK_COST_PER_SUBTASK
        } else {
          value += avg
        }
      }
      if (!cancelled) setEstimate(items.length > 0 ? { value, roughly } : null)
    })()
    return () => {
      cancelled = true
    }
  }, [items])

  const patch = (id: string, changes: Partial<PipelineSubtask>) =>
    setItems((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)))

  const remove = (id: string) => setItems((prev) => prev.filter((s) => s.id !== id))

  const move = (index: number, delta: number) =>
    setItems((prev) => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ ...well, padding: '8px 9px' }}>
        <div style={{ fontSize: '10px', color: ps.textFaint, marginBottom: '3px' }}>Задача</div>
        <div style={{ fontSize: '11px', color: ps.text, lineHeight: 1.55 }}>{run.goal}</div>
        {run.stack && (
          <div style={{ fontSize: '10px', color: ps.accentHover, marginTop: '5px' }}>
            Стек: {run.stack}
          </div>
        )}
        {estimate && (
          <div style={{ fontSize: '10px', color: ps.textFaint, marginTop: '5px' }}>
            Ориентировочно ≈ ${estimate.value.toFixed(2)} за прогон
            {estimate.roughly
              ? ' (мало истории по исполнителю — грубая прикидка)'
              : ' (по среднему прошлому расходу за подзадачу)'}
            , без учёта возможных исправлений
          </div>
        )}
      </div>

      <div style={{ fontSize: '10px', color: ps.textDim, lineHeight: 1.6 }}>
        Подзадачи выполняются сверху вниз. Проверь порядок и исполнителей — дальше конвейер
        отработает без остановок до готового результата.
      </div>

      <div style={{ maxHeight: '46vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {items.map((s, i) => (
          <div
            key={s.id}
            style={{
              border: `1px solid ${ps.border}`,
              borderLeft: `2px solid ${s.assignee === 'frontend' ? ps.info : ps.accent}`,
              borderRadius: '2px',
              padding: '7px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
              background: '#2b2b2b',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '10px', color: ps.textFaint, width: '14px' }}>{i + 1}.</span>
              <input
                value={s.title}
                onChange={(e) => patch(s.id, { title: e.target.value })}
                style={{ ...input, flex: 1, height: '20px' }}
              />
              <IconBtn name="chevronUp" title="Выше" onClick={() => move(i, -1)} />
              <IconBtn name="chevronDown" title="Ниже" onClick={() => move(i, 1)} />
              <IconBtn name="trash" title="Убрать" danger onClick={() => remove(s.id)} />
            </div>

            <textarea
              value={s.description}
              onChange={(e) => patch(s.id, { description: e.target.value })}
              rows={2}
              placeholder="Что именно сделать, какие файлы создать"
              style={{
                width: '100%',
                padding: '4px 6px',
                border: `1px solid ${ps.borderInput}`,
                borderRadius: '2px',
                background: ps.sunken,
                color: ps.text,
                fontSize: '11px',
                fontFamily: fonts.ui,
                lineHeight: 1.5,
                resize: 'vertical',
              }}
            />

            <div style={{ display: 'flex', gap: '4px' }}>
              {ASSIGNEES.map((a) => (
                <button
                  key={a.id}
                  onClick={() => patch(s.id, { assignee: a.id })}
                  style={{
                    padding: '2px 8px',
                    border: `1px solid ${s.assignee === a.id ? ps.accent : ps.borderLight}`,
                    borderRadius: '2px',
                    background: s.assignee === a.id ? ps.accent : 'transparent',
                    color: s.assignee === a.id ? '#fff' : ps.textDim,
                    fontSize: '10px',
                    cursor: 'pointer',
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {items.length === 0 && (
        <div style={{ fontSize: '11px', color: ps.err }}>
          Не осталось ни одной подзадачи — запускать нечего.
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={button}>
          Отменить запуск
        </button>
        <button
          onClick={() => items.length > 0 && onApprove(items)}
          style={items.length > 0 ? buttonPrimary : { ...button, color: ps.textDisabled }}
        >
          <Icon name="play" size={12} />
          Поехали
        </button>
      </div>
    </div>
  )
}

function IconBtn({
  name,
  title,
  onClick,
  danger,
}: {
  name: 'chevronUp' | 'chevronDown' | 'trash'
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: '20px',
        height: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: '2px',
        background: 'transparent',
        color: danger ? '#c07a7a' : ps.textDim,
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }}
      onMouseOver={(e) => (e.currentTarget.style.background = danger ? '#4a2c2c' : ps.hover)}
      onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon name={name} size={12} />
    </button>
  )
}
