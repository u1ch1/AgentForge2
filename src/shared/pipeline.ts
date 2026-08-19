/**
 * Типы конвейера — общие для main (владелец состояния), preload (мост) и
 * renderer (отображение). Раньше каждый слой держал свою копию вручную; любая
 * правка (например, новое поле в PipelineRun) требовала синхронно поправить
 * три места и легко расходилась молча. Теперь тип один, слои его импортируют.
 */

export type PipelineStatus =
  | 'idle'
  | 'analyzing'
  /** Analyst задал уточняющий вопрос — конвейер ждёт ответа пользователя. */
  | 'awaiting_clarification'
  | 'awaiting_analysis'
  | 'planning'
  | 'awaiting_plan'
  | 'working'
  | 'verifying'
  | 'fixing'
  | 'done'
  /** Код написан, но проверить его было нечем — это не успех и не провал. */
  | 'unverified'
  | 'failed'
  | 'stopped'
  /** Прогон оборвался вместе с приложением — восстановлению не подлежит. */
  | 'interrupted'

export type Assignee = 'frontend' | 'backend'

export interface PipelineAnalysis {
  /** 0-100: вероятность довести задачу до рабочего результата этим составом. */
  feasibility: number
  /** 0-100: какую долю объёма задачи конвейер закроет своими силами. */
  coverage: number
  /** Конкретные пункты нехватки — доступы, интеграции, ручная работа. */
  missing: string[]
  summary: string
}

export interface PipelineClarification {
  question: string
  /** null, пока пользователь не ответил — гейт `awaiting_clarification` открыт. */
  answer: string | null
}

export interface PipelineSubtask {
  id: string
  title: string
  description: string
  assignee: Assignee
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  /** Файлы, записанные при выполнении этой подзадачи. */
  files: string[]
}

export interface PipelineLogEntry {
  at: number
  kind: 'info' | 'ok' | 'err'
  agent?: string
  text: string
}

export interface PipelineRun {
  id: string
  projectId: string
  goal: string
  status: PipelineStatus
  stack: string
  subtasks: PipelineSubtask[]
  log: PipelineLogEntry[]
  /** Оценка Analyst до начала работ — вероятность успеха и чего не хватает. */
  analysis: PipelineAnalysis | null
  /** Уточняющий вопрос Analyst и (если уже дан) ответ пользователя. */
  clarification: PipelineClarification | null
  /** Итог последнего прогона проверок — то, на основании чего выносится вердикт. */
  checks: { ran: boolean; passed: boolean; summary: string } | null
  /** Итог «подними и постучись»: работает ли приложение, а не только компилируется. */
  runtime: { ran: boolean; ok: boolean; summary: string } | null
  /** Оформление: сколько замечаний было и сколько осталось после дизайнера. */
  design: { before: number; after: number | null } | null
  /** Снимок готовой страницы — путь в данных приложения, не в папке проекта. */
  screenshot: string | null
  /** Замечания Тестера: critical блокирует приёмку наравне с падением сборки. */
  review: { critical: string[]; text: string } | null
  fixAttempts: number
  taskId: string | null
  startedAt: number
  finishedAt: number | null
}
