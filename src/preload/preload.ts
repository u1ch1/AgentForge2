import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron'

// ---------------------------------------------------------------------------
// Типы, общие для main и renderer
// ---------------------------------------------------------------------------

export interface AgentInfo {
  id: string
  name: string
  role: string
  /** Имя иконки, не эмодзи. */
  icon: string
  model: string
  heavyModel: string
  mode: 'auto' | 'kimi' | 'claude'
}

export interface ModelInfo {
  id: string
  label: string
  provider: 'claude' | 'kimi'
  /** true — список получен от API провайдера, false — встроенный запасной. */
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

export interface UsageInfo {
  daily: number
  budget: number
  economyMode: boolean
}

export interface AgentUsage {
  agentId: string
  agentName: string
  inputTokens: number
  outputTokens: number
  cost: number
  messageCount: number
}

export interface SessionUsage {
  sessionStart: string
  agents: Record<string, AgentUsage>
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  totalMessages: number
}

export interface AgentFile {
  name: string
  path: string
  content: string
  isNew?: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export type StreamChunk =
  | { type: 'chunk'; text: string }
  | {
      type: 'done'
      usage: { inputTokens: number; outputTokens: number; cost: number; budgetTriggered: boolean }
      provider: 'claude' | 'kimi'
      model: string
    }
  | { type: 'error'; message: string }

export interface ProviderKeys {
  claude: string
  kimi: string
}

export interface KeyStatus {
  claude: boolean
  kimi: boolean
  /** true — ключи переживут перезапуск (ОС предоставляет шифрование). */
  persistent: boolean
}

export interface ProviderConfig {
  provider: 'claude' | 'kimi'
  apiKey: string
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

export interface StoredMessage {
  id: string
  sender: 'user' | 'agent'
  text: string
  timestamp: number
  provider?: 'claude' | 'kimi'
  model?: string
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

export interface OpResult {
  ok: boolean
  message?: string
  count?: number
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

export interface MCPFile {
  path: string
  content: string
  language: string
}

export interface SearchHit {
  file: string
  line: number
  text: string
}

export interface DeployResult {
  success: boolean
  files: string[]
  message: string
}

export interface ExportResult {
  status: 'ok' | 'cancelled' | 'empty' | 'error'
  path?: string
  /** Сколько файлов попало в архив. */
  count?: number
  message?: string
}

export interface PreviewStartResult {
  success: boolean
  url: string | null
  alreadyRunning?: boolean
  error?: string
}

export interface WorkspaceInfo {
  workspace: string
  data: string
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
  | 'unverified'
  | 'failed'
  | 'stopped'
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
  feasibility: number
  coverage: number
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
  analysis: PipelineAnalysis | null
  checks: { ran: boolean; passed: boolean; summary: string } | null
  runtime: { ran: boolean; ok: boolean; summary: string } | null
  design: { before: number; after: number | null } | null
  screenshot: string | null
  review: { critical: string[]; text: string } | null
  fixAttempts: number
  taskId: string | null
  startedAt: number
  finishedAt: number | null
}

export interface ElectronAPI {
  // Ключи и провайдеры
  setKeys: (claude: string, kimi: string) => Promise<void>
  getKeys: () => Promise<ProviderKeys>
  setProvider: (cfg: ProviderConfig) => Promise<void>
  getKeyStatus: () => Promise<KeyStatus>

  // Агенты
  getAgents: () => Promise<AgentInfo[]>
  setAgentMode: (agentId: string, mode: 'auto' | 'kimi' | 'claude') => Promise<void>
  setAgentModel: (agentId: string, model: string) => Promise<void>

  // Модели провайдеров
  listModels: (force?: boolean) => Promise<AllModels>
  testKey: (provider: 'claude' | 'kimi') => Promise<{ ok: boolean; message: string }>
  isPriceKnown: (model: string) => Promise<boolean>

  // Бюджет и настройки
  getUsage: () => Promise<UsageInfo>
  resetEconomy: () => Promise<void>
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>

  // Стриминг
  streamChat: (
    requestId: string,
    agentId: string,
    messages: ChatMessage[],
    forceHeavy?: boolean
  ) => void
  abortChat: (requestId: string) => Promise<void>
  onStreamChunk: (cb: (requestId: string, chunk: StreamChunk) => void) => () => void

  // Токены
  getSessionUsage: () => Promise<SessionUsage>
  getAgentUsage: (agentId: string) => Promise<AgentUsage | null>
  resetSessionUsage: () => Promise<void>

  // Файлы агентов
  listFiles: () => Promise<AgentFile[]>
  readFile: (filePath: string) => Promise<string>
  writeFile: (filePath: string, content: string) => Promise<boolean>
  createFile: (filename: string) => Promise<AgentFile | null>
  deleteFile: (filePath: string) => Promise<boolean>

  // Декомпозиция / Auto-Fix
  getTasks: () => Promise<TaskTree[]>
  addTask: (task: TaskTree) => Promise<void>
  updateTask: (taskId: string, updates: Partial<TaskTree>) => Promise<void>
  updateSubtask: (taskId: string, subtaskId: string, updates: Partial<Subtask>) => Promise<void>
  addSubtask: (taskId: string, subtask: Subtask) => Promise<boolean>
  deleteTask: (taskId: string) => Promise<void>
  createAutoFix: (
    parentTaskId: string,
    errorDescription: string,
    originalCode: string,
    assignee: string
  ) => Promise<Subtask | null>
  getPendingFixes: () => Promise<{ taskId: string; subtask: Subtask }[]>
  resolveFix: (taskId: string, subtaskId: string, fixedCode: string) => Promise<void>

  // Проекты
  listProjects: () => Promise<{ projects: Project[]; activeId: string }>
  setActiveProject: (id: string) => Promise<Project | null>
  createProject: (name: string) => Promise<Project>
  renameProject: (id: string, name: string) => Promise<Project | null>
  deleteProject: (id: string) => Promise<{ ok: boolean; reason?: string }>
  getProjectDir: () => Promise<{ dir: string; project: Project }>

  // Чаты (по паре проект + агент)
  getChat: (agentId: string) => Promise<StoredMessage[]>
  getProjectChats: () => Promise<Record<string, StoredMessage[]>>
  appendMessage: (agentId: string, message: StoredMessage) => Promise<void>
  clearChat: (agentId: string) => Promise<void>
  /** Полная замена диалога — для редактирования, повтора ответа и удаления сообщения. */
  setChatMessages: (agentId: string, messages: StoredMessage[]) => Promise<void>
  getChatSummary: () => Promise<ChatSummary[]>
  getChatCounts: () => Promise<Record<string, number>>
  searchChats: (query: string) => Promise<ChatSearchHit[]>

  // Файлы проекта
  filesList: (dir?: string) => Promise<{ entries: FileEntry[]; dir: string; error?: string }>
  filesAdd: (dir: string) => Promise<OpResult>
  filesAddPaths: (dir: string, paths: string[]) => Promise<OpResult>
  filesMkdir: (dir: string, name: string) => Promise<OpResult>
  filesRemove: (path: string) => Promise<OpResult>
  filesRename: (path: string, name: string) => Promise<OpResult>
  filesReveal: (path?: string) => Promise<void>
  /** Запись файла по пути внутри проекта — для авто-сохранения кода от Worker'ов. */
  writeProjectFile: (relPath: string, content: string) => Promise<OpResult>
  /** Абсолютный путь перетащенного файла (Electron 32+ прячет File.path). */
  pathForFile: (file: File) => string

  // Окно (рамка своя, не системная)
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<boolean>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void

  // Буфер обмена
  copyText: (text: string) => Promise<void>

  // Экспорт и шаблоны
  exportProject: () => Promise<ExportResult>
  listTemplates: () => Promise<TemplateInfo[]>
  createTemplate: (type: string) => Promise<{ success: boolean; path: string }>

  // Память проекта
  getProjectMemory: () => Promise<ProjectContext>
  updateProjectMemory: (updates: Partial<ProjectContext>) => Promise<void>
  addEndpoint: (method: string, path: string, description: string) => Promise<void>
  addComponent: (name: string) => Promise<void>
  addStack: (tech: string) => Promise<void>
  addPattern: (pattern: string) => Promise<void>
  addEnvVar: (name: string) => Promise<void>
  resetProjectMemory: () => Promise<void>

  // MCP
  mcpReadFile: (filePath: string) => Promise<MCPFile | null>
  mcpWriteFile: (filePath: string, content: string) => Promise<boolean>
  mcpListFiles: (dirPath?: string) => Promise<string[]>
  mcpSearchCode: (query: string, dirPath?: string) => Promise<SearchHit[]>

  // Deploy
  deployPrepare: (config: {
    platform: 'railway' | 'vercel' | 'docker'
    frontendDir: string
    backendDir: string
  }) => Promise<DeployResult>
  deployExport: () => Promise<ExportResult>

  // Live Preview
  previewStart: (projectPath: string) => Promise<PreviewStartResult>
  previewStop: () => Promise<{ success: boolean }>
  previewGetUrl: () => Promise<{ url: string | null }>
  previewGetLogs: () => Promise<{ logs: string[] }>

  // Конвейер: задача → план → воркеры → проверка
  pipelineStart: (goal: string) => Promise<PipelineRun | null>
  pipelineGet: () => Promise<PipelineRun | null>
  pipelineApproveAnalysis: () => Promise<void>
  pipelineApprove: (edited?: PipelineSubtask[]) => Promise<void>
  pipelineStop: () => Promise<void>
  onPipelineUpdate: (cb: (run: PipelineRun | null) => void) => () => void

  // Рабочая папка
  getWorkspace: () => Promise<WorkspaceInfo>
  chooseWorkspace: () => Promise<{ changed: boolean; workspace?: string }>
  revealWorkspace: (sub?: string) => Promise<void>
  revealWorkspaceRoot: () => Promise<void>
}

const api: ElectronAPI = {
  setKeys: (claude, kimi) => ipcRenderer.invoke('api:setKeys', claude, kimi),
  getKeys: () => ipcRenderer.invoke('api:getKeys'),
  setProvider: (cfg) => ipcRenderer.invoke('api:setProvider', cfg),
  getKeyStatus: () => ipcRenderer.invoke('api:getKeyStatus'),

  getAgents: () => ipcRenderer.invoke('api:getAgents'),
  setAgentMode: (id, mode) => ipcRenderer.invoke('api:setAgentMode', id, mode),
  setAgentModel: (id, model) => ipcRenderer.invoke('api:setAgentModel', id, model),

  listModels: (force) => ipcRenderer.invoke('api:listModels', force),
  testKey: (provider) => ipcRenderer.invoke('api:testKey', provider),
  isPriceKnown: (model) => ipcRenderer.invoke('api:isPriceKnown', model),

  getUsage: () => ipcRenderer.invoke('api:getUsage'),
  resetEconomy: () => ipcRenderer.invoke('api:resetEconomy'),
  getSettings: () => ipcRenderer.invoke('api:getSettings'),
  updateSettings: (patch) => ipcRenderer.invoke('api:updateSettings', patch),

  streamChat: (requestId, agentId, messages, forceHeavy = false) => {
    ipcRenderer.send('api:streamChat', requestId, agentId, messages, forceHeavy)
  },
  abortChat: (requestId) => ipcRenderer.invoke('api:abortChat', requestId),
  onStreamChunk: (cb) => {
    const handler = (_e: IpcRendererEvent, requestId: string, chunk: StreamChunk) =>
      cb(requestId, chunk)
    ipcRenderer.on('api:streamChunk', handler)
    return () => {
      ipcRenderer.removeListener('api:streamChunk', handler)
    }
  },

  getSessionUsage: () => ipcRenderer.invoke('tracker:getSession'),
  getAgentUsage: (id) => ipcRenderer.invoke('tracker:getAgent', id),
  resetSessionUsage: () => ipcRenderer.invoke('tracker:reset'),

  listFiles: () => ipcRenderer.invoke('prompts:list'),
  readFile: (p) => ipcRenderer.invoke('prompts:read', p),
  writeFile: (p, c) => ipcRenderer.invoke('prompts:write', p, c),
  createFile: (n) => ipcRenderer.invoke('prompts:create', n),
  deleteFile: (p) => ipcRenderer.invoke('prompts:delete', p),

  getTasks: () => ipcRenderer.invoke('decomp:getTasks'),
  addTask: (t) => ipcRenderer.invoke('decomp:add', t),
  updateTask: (id, u) => ipcRenderer.invoke('decomp:update', id, u),
  updateSubtask: (tid, sid, u) => ipcRenderer.invoke('decomp:updateSubtask', tid, sid, u),
  addSubtask: (tid, st) => ipcRenderer.invoke('decomp:addSubtask', tid, st),
  deleteTask: (id) => ipcRenderer.invoke('decomp:delete', id),
  createAutoFix: (pid, err, code, assignee) =>
    ipcRenderer.invoke('decomp:createAutoFix', pid, err, code, assignee),
  getPendingFixes: () => ipcRenderer.invoke('decomp:getPendingFixes'),
  resolveFix: (tid, sid, code) => ipcRenderer.invoke('decomp:resolveFix', tid, sid, code),

  listProjects: () => ipcRenderer.invoke('projects:list'),
  setActiveProject: (id) => ipcRenderer.invoke('projects:setActive', id),
  createProject: (name) => ipcRenderer.invoke('projects:create', name),
  renameProject: (id, name) => ipcRenderer.invoke('projects:rename', id, name),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  getProjectDir: () => ipcRenderer.invoke('projects:dir'),

  getChat: (agentId) => ipcRenderer.invoke('chat:get', agentId),
  getProjectChats: () => ipcRenderer.invoke('chat:getProject'),
  appendMessage: (agentId, m) => ipcRenderer.invoke('chat:append', agentId, m),
  clearChat: (agentId) => ipcRenderer.invoke('chat:clear', agentId),
  setChatMessages: (agentId, msgs) => ipcRenderer.invoke('chat:set', agentId, msgs),
  getChatSummary: () => ipcRenderer.invoke('chat:summary'),
  getChatCounts: () => ipcRenderer.invoke('chat:counts'),
  searchChats: (q) => ipcRenderer.invoke('chat:search', q),

  filesList: (dir) => ipcRenderer.invoke('files:list', dir),
  filesAdd: (dir) => ipcRenderer.invoke('files:add', dir),
  filesAddPaths: (dir, paths) => ipcRenderer.invoke('files:addPaths', dir, paths),
  filesMkdir: (dir, name) => ipcRenderer.invoke('files:mkdir', dir, name),
  filesRemove: (p) => ipcRenderer.invoke('files:remove', p),
  filesRename: (p, name) => ipcRenderer.invoke('files:rename', p, name),
  filesReveal: (p) => ipcRenderer.invoke('files:reveal', p),
  writeProjectFile: (p, c) => ipcRenderer.invoke('files:writeAt', p, c),
  pathForFile: (file) => webUtils.getPathForFile(file),

  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (cb) => {
    const handler = (_e: IpcRendererEvent, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window:maximizedChanged', handler)
    return () => ipcRenderer.removeListener('window:maximizedChanged', handler)
  },

  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  exportProject: () => ipcRenderer.invoke('project:export'),
  listTemplates: () => ipcRenderer.invoke('template:list'),
  createTemplate: (type) => ipcRenderer.invoke('template:create', type),

  getProjectMemory: () => ipcRenderer.invoke('memory:get'),
  updateProjectMemory: (u) => ipcRenderer.invoke('memory:update', u),
  addEndpoint: (m, p, d) => ipcRenderer.invoke('memory:addEndpoint', m, p, d),
  addComponent: (n) => ipcRenderer.invoke('memory:addComponent', n),
  addStack: (t) => ipcRenderer.invoke('memory:addStack', t),
  addPattern: (p) => ipcRenderer.invoke('memory:addPattern', p),
  addEnvVar: (n) => ipcRenderer.invoke('memory:addEnvVar', n),
  resetProjectMemory: () => ipcRenderer.invoke('memory:reset'),

  mcpReadFile: (p) => ipcRenderer.invoke('mcp:readFile', p),
  mcpWriteFile: (p, c) => ipcRenderer.invoke('mcp:writeFile', p, c),
  mcpListFiles: (p) => ipcRenderer.invoke('mcp:listFiles', p),
  mcpSearchCode: (q, p) => ipcRenderer.invoke('mcp:searchCode', q, p),

  deployPrepare: (cfg) => ipcRenderer.invoke('deploy:prepare', cfg),
  deployExport: () => ipcRenderer.invoke('deploy:export'),

  previewStart: (p) => ipcRenderer.invoke('preview:start', p),
  previewStop: () => ipcRenderer.invoke('preview:stop'),
  previewGetUrl: () => ipcRenderer.invoke('preview:getUrl'),
  previewGetLogs: () => ipcRenderer.invoke('preview:getLogs'),

  pipelineStart: (goal) => ipcRenderer.invoke('pipeline:start', goal),
  pipelineGet: () => ipcRenderer.invoke('pipeline:get'),
  pipelineApproveAnalysis: () => ipcRenderer.invoke('pipeline:approveAnalysis'),
  pipelineApprove: (edited) => ipcRenderer.invoke('pipeline:approve', edited),
  pipelineStop: () => ipcRenderer.invoke('pipeline:stop'),
  onPipelineUpdate: (cb) => {
    const handler = (_e: IpcRendererEvent, r: PipelineRun | null) => cb(r)
    ipcRenderer.on('pipeline:update', handler)
    return () => ipcRenderer.removeListener('pipeline:update', handler)
  },

  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  revealWorkspace: (sub) => ipcRenderer.invoke('workspace:reveal', sub),
  revealWorkspaceRoot: () => ipcRenderer.invoke('workspace:revealRoot'),
}

contextBridge.exposeInMainWorld('electronAPI', api)
