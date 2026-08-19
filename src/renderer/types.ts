import type { IconName } from './icons'
import type {
  PipelineStatus,
  PipelineSubtask,
  PipelineLogEntry,
  PipelineAnalysis,
  PipelineRun,
} from '../shared/pipeline'

export type { PipelineStatus, PipelineSubtask, PipelineLogEntry, PipelineAnalysis, PipelineRun }

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
