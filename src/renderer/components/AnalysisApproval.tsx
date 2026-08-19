import type { PipelineRun } from '../types'
import { ps, button, buttonPrimary, well } from '../theme'
import { Icon } from '../icons'

interface AnalysisApprovalProps {
  run: PipelineRun
  onApprove: () => void
  onReject: () => void
}

function pctColor(value: number): string {
  if (value >= 70) return ps.ok
  if (value >= 40) return ps.warn
  return ps.err
}

/**
 * Первая остановка конвейера: Analyst уже оценил задачу, пользователь решает,
 * делать её вообще или нет — до того, как Admin потратит запрос на план.
 */
export default function AnalysisApproval({ run, onApprove, onReject }: AnalysisApprovalProps) {
  const a = run.analysis
  if (!a) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ ...well, padding: '8px 9px' }}>
        <div style={{ fontSize: '10px', color: ps.textFaint, marginBottom: '3px' }}>Задача</div>
        <div style={{ fontSize: '11px', color: ps.text, lineHeight: 1.55 }}>{run.goal}</div>
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <Metric label="Выполнимость" value={a.feasibility} />
        <Metric label="Покрытие конвейером" value={a.coverage} />
      </div>

      {a.summary && (
        <div style={{ fontSize: '11px', color: ps.text, lineHeight: 1.55 }}>{a.summary}</div>
      )}

      {a.missing.length > 0 && (
        <div>
          <div style={{ fontSize: '10px', color: ps.textFaint, marginBottom: '4px' }}>
            Не хватает
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {a.missing.map((m, i) => (
              <div key={i} style={{ fontSize: '11px', color: ps.warn, lineHeight: 1.5 }}>
                • {m}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: '10px', color: ps.textDim, lineHeight: 1.6 }}>
        Если подтвердите — задача уходит Admin'у, и дальше конвейер работает как обычно,
        вплоть до утверждения плана.
      </div>

      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
        <button onClick={onReject} style={button}>
          Не делать
        </button>
        <button onClick={onApprove} style={buttonPrimary}>
          <Icon name="play" size={12} />
          Делать
        </button>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ ...well, flex: 1, padding: '8px 9px', textAlign: 'center' }}>
      <div style={{ fontSize: '20px', color: pctColor(value), fontWeight: 600 }}>{value}%</div>
      <div style={{ fontSize: '10px', color: ps.textFaint, marginTop: '2px' }}>{label}</div>
    </div>
  )
}
