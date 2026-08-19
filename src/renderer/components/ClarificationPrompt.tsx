import { useState } from 'react'
import type { PipelineRun } from '../types'
import { ps, fonts, button, buttonPrimary, well } from '../theme'
import { Icon } from '../icons'

interface ClarificationPromptProps {
  run: PipelineRun
  onSubmit: (answer: string) => void
  onCancel: () => void
}

/**
 * Промежуточная остановка перед оценкой Analyst: он не может честно назвать
 * проценты без ключевой детали и задаёт один вопрос вместо цифр.
 */
export default function ClarificationPrompt({ run, onSubmit, onCancel }: ClarificationPromptProps) {
  const [answer, setAnswer] = useState('')
  const question = run.clarification?.question
  if (!question) return null

  const submit = () => {
    if (answer.trim()) onSubmit(answer.trim())
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ ...well, padding: '8px 9px' }}>
        <div style={{ fontSize: '10px', color: ps.textFaint, marginBottom: '3px' }}>Задача</div>
        <div style={{ fontSize: '11px', color: ps.text, lineHeight: 1.55 }}>{run.goal}</div>
      </div>

      <div style={{ fontSize: '11px', lineHeight: 1.55 }}>
        <span style={{ color: ps.textFaint }}>Аналитику не хватает данных для оценки:</span>
        <div style={{ color: ps.text, marginTop: '4px' }}>{question}</div>
      </div>

      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
        rows={3}
        placeholder="Ваш ответ…"
        autoFocus
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

      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={button}>
          Отменить запуск
        </button>
        <button onClick={submit} style={answer.trim() ? buttonPrimary : { ...button, color: ps.textDisabled }}>
          <Icon name="send" size={12} />
          Ответить
        </button>
      </div>
    </div>
  )
}
