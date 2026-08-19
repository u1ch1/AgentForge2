import type { Assignee, PipelineAnalysis, PipelineSubtask } from '../shared/pipeline'

export interface ClarificationRequest {
  question: string
}

export type AnalysisOutcome =
  | { kind: 'analysis'; value: PipelineAnalysis }
  | { kind: 'clarification'; value: ClarificationRequest }

/**
 * Разбор и форматирование текста, которым обмениваются агенты и конвейер —
 * вынесено из orchestrator.ts отдельно от всего, что требует сети, диска или
 * состояния прогона. Каждая функция здесь чистая: один и тот же вход всегда
 * даёт один и тот же выход, поэтому это единственное место в конвейере,
 * которое покрыто unit-тестами (см. pipeline-parsing.test.ts).
 */

/** Не более стольких подзадач в одном плане — иначе прогон не окупается. */
export const MAX_SUBTASKS = 12

/** Сколько файлов дошлём воркеру по запросу: больше — и запрос выест весь бюджет. */
export const MAX_REQUESTED_FILES = 6

export const AGENT_NAME: Record<Assignee, string> = { frontend: 'Worker1', backend: 'Worker2' }

/** Вырезает JSON из ответа модели: объект по умолчанию, массив — для сценария. */
export function extractJson(text: string, open = '{', close = '}'): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf(open)
  const end = body.lastIndexOf(close)
  if (start === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

/** Число в проценты 0..100 — модель может прислать строку или дробь. */
export function clampPct(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

interface RawAnalysis {
  feasibility?: unknown
  coverage?: unknown
  missing?: unknown
  summary?: unknown
}

export function parseAnalysis(text: string): PipelineAnalysis | null {
  const json = extractJson(text)
  if (!json) return null

  let raw: RawAnalysis
  try {
    raw = JSON.parse(json) as RawAnalysis
  } catch {
    return null
  }
  if (raw.feasibility === undefined || raw.coverage === undefined) return null

  const missing = Array.isArray(raw.missing)
    ? raw.missing.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
    : []

  return {
    feasibility: clampPct(raw.feasibility),
    coverage: clampPct(raw.coverage),
    missing,
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
  }
}

/** Сырой JSON анализа в чате нечитаем — показываем разметкой, её чат уже умеет. */
export function renderAnalysis(a: PipelineAnalysis): string {
  const lines = [
    '## Анализ выполнимости',
    '',
    `**Выполнимость:** ${a.feasibility}%`,
    `**Покрытие задачи конвейером:** ${a.coverage}%`,
  ]
  if (a.summary) lines.push('', a.summary)
  if (a.missing.length > 0) {
    lines.push('', '**Не хватает:**')
    a.missing.forEach((m) => lines.push(`- ${m}`))
  }
  return lines.join('\n')
}

/**
 * Разбирает ответ Analyst, который может быть либо готовой оценкой, либо
 * просьбой уточнить задачу — вместо чисел модель вправе прислать один вопрос,
 * если оценивать пока нечего.
 *
 * Различаем по форме: `{feasibility, coverage, ...}` — оценка, `{question}` —
 * запрос уточнения. Валидация самой оценки не дублируется — переиспользуем
 * parseAnalysis на полном тексте.
 */
export function parseAnalysisOutcome(text: string): AnalysisOutcome | null {
  const json = extractJson(text)
  if (!json) return null

  let raw: RawAnalysis & { question?: unknown }
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }

  if (raw.feasibility === undefined && raw.coverage === undefined) {
    const question = typeof raw.question === 'string' ? raw.question.trim() : ''
    return question ? { kind: 'clarification', value: { question } } : null
  }

  const analysis = parseAnalysis(text)
  return analysis ? { kind: 'analysis', value: analysis } : null
}

/** Вопрос Analyst в чате — той же разметкой, что и готовый анализ. */
export function renderClarification(question: string): string {
  return `## Нужно уточнение\n\n${question}`
}

interface RawPlan {
  stack?: unknown
  subtasks?: unknown
}

export function parsePlan(text: string): { stack: string; subtasks: PipelineSubtask[] } | null {
  const json = extractJson(text)
  if (!json) return null

  let raw: RawPlan
  try {
    raw = JSON.parse(json) as RawPlan
  } catch {
    return null
  }
  if (!Array.isArray(raw.subtasks) || raw.subtasks.length === 0) return null

  const subtasks: PipelineSubtask[] = []
  for (const item of raw.subtasks.slice(0, MAX_SUBTASKS)) {
    const s = item as Record<string, unknown>
    const title = typeof s.title === 'string' ? s.title.trim() : ''
    if (!title) continue
    const assignee: Assignee = s.assignee === 'frontend' ? 'frontend' : 'backend'
    subtasks.push({
      id: `st-${subtasks.length + 1}-${Date.now()}`,
      title,
      description: typeof s.description === 'string' ? s.description.trim() : '',
      assignee,
      status: 'pending',
      files: [],
    })
  }
  if (subtasks.length === 0) return null

  return {
    stack: typeof raw.stack === 'string' ? raw.stack.trim() : '',
    subtasks,
  }
}

/** Сырой JSON плана в чате нечитаем — показываем разметкой, её чат уже умеет. */
export function renderPlan(stack: string, subtasks: PipelineSubtask[]): string {
  const lines = ['## План работ', '']
  if (stack) lines.push(`**Стек:** ${stack}`, '')
  subtasks.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.title}** — ${AGENT_NAME[s.assignee]}`)
    if (s.description) lines.push(`   ${s.description}`)
  })
  return lines.join('\n')
}

/**
 * Позиция первого упоминания файла в тексте — или -1.
 *
 * Простой indexOf здесь врёт: имя `c.md` находится внутри `spec.md`, а
 * `index.js` — внутри `index.jsx`. Поэтому совпадение засчитывается только на
 * границе имени: слева не должно быть куска другого имени, справа —
 * продолжения. Разделитель пути слева допустим, иначе `./src/app.ts` перестал
 * бы находиться по `src/app.ts`.
 */
export function indexOfMention(hayLower: string, needleLower: string): number {
  for (let from = 0; ; ) {
    const at = hayLower.indexOf(needleLower, from)
    if (at === -1) return -1
    const before = at === 0 ? '' : hayLower[at - 1]
    const after = hayLower[at + needleLower.length] ?? ''
    if (!/[a-z0-9_-]/.test(before) && !/[a-z0-9_]/.test(after)) return at
    from = at + 1
  }
}

/**
 * Ищет в ответе без кода имена реальных файлов проекта.
 *
 * Воркер по инструкции просит недостающий файл одной строкой. Опознаём такой
 * ответ не по формулировке (она произвольная), а по совпадению с деревом
 * проекта — так же надёжно и не зависит от языка ответа.
 */
export function extractRequestedFiles(text: string, known: string[]): string[] {
  const lower = text.toLowerCase()
  const hits: string[] = []

  const baseCount = new Map<string, number>()
  for (const f of known) {
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
    baseCount.set(base, (baseCount.get(base) ?? 0) + 1)
  }

  for (const f of known) {
    if (hits.length >= MAX_REQUESTED_FILES) break
    if (indexOfMention(lower, f.toLowerCase()) !== -1) {
      hits.push(f)
      continue
    }
    // Часто называют только имя файла. Принимаем, если оно однозначное:
    // при двух Index.tsx в разных папках непонятно, какой именно просят.
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
    if (base.length >= 5 && baseCount.get(base) === 1 && indexOfMention(lower, base) !== -1) hits.push(f)
  }
  return hits
}

/**
 * Вытаскивает критические замечания из отчёта.
 *
 * Строку-легенду («отчёт в формате [CRITICAL] / [WARNING] / [OK]») модель
 * повторяет охотно — считать её замечанием нельзя, поэтому строки со всеми
 * тремя метками сразу отбрасываем, как и метку без текста после неё.
 */
export function extractCritical(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*>\s]+/, '')
    if (!/\[\s*critical\s*\]/i.test(line)) continue
    if (/\[\s*warning\s*\]/i.test(line) && /\[\s*ok\s*\]/i.test(line)) continue
    const body = line.replace(/\*\*/g, '').replace(/\[\s*critical\s*\]/i, '').trim()
    if (body.length < 8) continue
    out.push(line.slice(0, 300))
  }
  return out
}
