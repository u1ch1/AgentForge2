import type { IconName } from './icons'

export interface Agent {
  id: string
  name: string
  role: string
  /** Имя иконки из icons.tsx. */
  icon: string
  model: string
  heavyModel: string
  mode: 'auto' | 'kimi' | 'claude'
}

export interface Message {
  id: string
  sender: 'user' | 'agent'
  text: string
  timestamp: number
  provider?: 'claude' | 'kimi'
  model?: string
}

export interface UsageInfo {
  daily: number
  budget: number
  economyMode: boolean
}

export interface ExportResult {
  status: 'ok' | 'cancelled' | 'empty' | 'error'
  path?: string
  /** Сколько файлов попало в архив. */
  count?: number
  message?: string
}

export interface KeyStatus {
  claude: boolean
  kimi: boolean
  persistent: boolean
}

export interface AppSettings {
  dailyBudget: number
  kimiBaseUrl: string
  chatFontSize: 'small' | 'medium' | 'large'
  chatWidth: 'full' | 'comfortable'
  chatShowTimestamps: boolean
  chatShowModelBadge: boolean
  chatSound: boolean
}

export interface ModelInfo {
  id: string
  label: string
  provider: 'claude' | 'kimi'
  live: boolean
}

export interface ModelListResult {
  models: ModelInfo[]
  error?: string
}

export interface AllModels {
  claude: ModelListResult
  kimi: ModelListResult
}

export interface Subtask {
  id: string
  title: string
  description: string
  assignee: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'needs_fix'
  parentId?: string
  autoFix?: boolean
  originalCode?: string
  errorDescription?: string
}

export interface TaskTree {
  id: string
  title: string
  description: string
  subtasks: Subtask[]
  createdAt: string
  autoFixEnabled: boolean
}

export interface Project {
  id: string
  name: string
  slug: string
  createdAt: string
  color: string
}

export interface ChatSummary {
  agentId: string
  count: number
  lastAt: number | null
}

export interface ChatSearchHit {
  projectId: string
  projectName: string
  agentId: string
  messageId: string
  text: string
  timestamp: number
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: number
}

export interface TemplateInfo {
  id: string
  name: string
  description: string
  icon: string
}

export interface ProjectContext {
  projectId: string
  name: string
  stack: string[]
  patterns: string[]
  endpoints: { method: string; path: string; description: string }[]
  components: string[]
  envVars: string[]
  notes: string
  lastUpdated: string
}

export type PipelineStatus =
  | 'idle'
  | 'analyzing'
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
  /** Прогон оборвался вместе с приложением. */
  | 'interrupted'

export interface PipelineSubtask {
  id: string
  title: string
  description: string
  assignee: 'frontend' | 'backend'
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  files: string[]
}

export interface PipelineLogEntry {
  at: number
  kind: 'info' | 'ok' | 'err'
  agent?: string
  text: string
}

export interface PipelineAnalysis {
  /** 0-100: вероятность довести задачу до рабочего результата этим составом. */
  feasibility: number
  /** 0-100: какую долю объёма задачи конвейер закроет своими силами. */
  coverage: number
  /** Конкретные пункты нехватки — доступы, интеграции, ручная работа. */
  missing: string[]
  summary: string
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
  checks: { ran: boolean; passed: boolean; summary: string } | null
  /** Итог «подними и постучись»: работает ли приложение, а не только компилируется. */
  runtime: { ran: boolean; ok: boolean; summary: string } | null
  /** Оформление: сколько замечаний было и сколько осталось после дизайнера. */
  design: { before: number; after: number | null } | null
  /** Снимок готовой страницы. */
  screenshot: string | null
  /** Замечания Тестера: critical блокирует приёмку наравне с падением сборки. */
  review: { critical: string[]; text: string } | null
  fixAttempts: number
  taskId: string | null
  startedAt: number
  finishedAt: number | null
}

/** Worker1/Worker2 — их чат показывает только код (с автосохранением в проект), без прозы и промптов. */
export function isCodeOnlyAgent(agentId: string): boolean {
  return agentId === 'frontend' || agentId === 'backend'
}

/** Провайдер выводится из имени модели — так же, как в main-процессе. */
export function providerForModel(model: string): 'claude' | 'kimi' {
  return model.startsWith('claude') ? 'claude' : 'kimi'
}

/** Иконка агента с запасным вариантом, если в конфиге неизвестное имя. */
export function agentIcon(name: string): IconName {
  const known: IconName[] = ['target', 'layout', 'server', 'bug', 'search']
  return known.includes(name as IconName) ? (name as IconName) : 'move'
}

/** Иконка шаблона проекта — по его id. */
export function templateIcon(id: string): IconName {
  if (id.includes('fastapi')) return 'server'
  if (id.includes('telegram')) return 'send'
  return 'layout'
}
