import Anthropic from '@anthropic-ai/sdk'
import { ipcMain, IpcMainInvokeEvent } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getWorkspaceDir } from './paths'
import { loadJson, saveJson } from './persistence'
import { loadKeys, saveKeys, isEncryptionAvailable } from './secure-store'
import { recordUsage, getSessionUsage } from './token-tracker'
import { getSystemPromptWithMemory } from './project-memory'

export type Provider = 'claude' | 'kimi'
export type AgentMode = 'auto' | 'kimi' | 'claude'

export interface AgentConfig {
  id: string
  name: string
  role: string
  /** Имя иконки из renderer/icons.tsx — не эмодзи. */
  icon: string
  model: string
  heavyModel: string
  systemPromptPath: string
  mode: AgentMode
}

export interface ModelInfo {
  id: string
  label: string
  provider: Provider
  /** true — модель пришла из API провайдера, false — из встроенного списка. */
  live: boolean
}

export interface ModelListResult {
  models: ModelInfo[]
  error?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ProviderConfig {
  provider: Provider
  apiKey: string
}

export interface AppSettings {
  dailyBudget: number
  kimiBaseUrl: string
  // Внешний вид чата — хранится здесь же, а не в localStorage: у renderer'а,
  // загруженного через file://, происхождение хранилища не гарантированно
  // стабильно между сборками, а этот файл уже единая точка правды для настроек.
  chatFontSize: 'small' | 'medium' | 'large'
  chatWidth: 'full' | 'comfortable'
  chatShowTimestamps: boolean
  chatShowModelBadge: boolean
  chatSound: boolean
}

const SETTINGS_FILE = 'app-settings.json'
const AGENTS_FILE = 'agents.json'

const DEFAULT_SETTINGS: AppSettings = {
  dailyBudget: 10,
  // Международный эндпоинт Moonshot. Для аккаунтов, зарегистрированных в Китае,
  // поменяйте на https://api.moonshot.cn/v1 в настройках.
  kimiBaseUrl: 'https://api.moonshot.ai/v1',
  chatFontSize: 'medium',
  chatWidth: 'comfortable',
  chatShowTimestamps: true,
  chatShowModelBadge: true,
  chatSound: false,
}

// ---------------------------------------------------------------------------
// Модели и цены
// ---------------------------------------------------------------------------

/**
 * Цены — доллары за МИЛЛИОН токенов (не за тысячу!).
 * Значения Moonshot приблизительные — сверьтесь с тарифами своего аккаунта
 * и поправьте здесь, если нужна точная бухгалтерия.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  // Moonshot / Kimi
  'moonshot-v1-8k': { input: 0.6, output: 0.6 },
  'moonshot-v1-32k': { input: 1.2, output: 1.2 },
  'moonshot-v1-128k': { input: 2.4, output: 2.4 },
}

/**
 * Если модели нет в таблице, берём цену «по умолчанию» для её провайдера.
 * Разные значения нужны, чтобы неизвестная модель Kimi не считалась
 * по тарифу Claude (это завысило бы расход в несколько раз).
 */
const FALLBACK_PRICE: Record<Provider, { input: number; output: number }> = {
  claude: { input: 3.0, output: 15.0 },
  kimi: { input: 1.2, output: 1.2 },
}

/**
 * Запасной список моделей — используется, только если API провайдера
 * недоступен или ключ не задан. Актуальный список приложение запрашивает
 * у провайдера через listModels().
 */
const STATIC_MODELS: ModelInfo[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'claude', live: false },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'claude', live: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'claude', live: false },
  { id: 'moonshot-v1-8k', label: 'Kimi 8K', provider: 'kimi', live: false },
  { id: 'moonshot-v1-32k', label: 'Kimi 32K', provider: 'kimi', live: false },
  { id: 'moonshot-v1-128k', label: 'Kimi 128K', provider: 'kimi', live: false },
]

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: 'analyst',
    name: 'Analyst',
    role: 'Анализ выполнимости',
    icon: 'search',
    model: 'moonshot-v1-32k',
    heavyModel: 'claude-sonnet-5',
    systemPromptPath: '.claude/agents/analyst-agent.md',
    mode: 'auto',
  },
  {
    id: 'admin',
    name: 'Admin',
    role: 'Координатор',
    icon: 'target',
    model: 'moonshot-v1-32k',
    heavyModel: 'claude-opus-5',
    systemPromptPath: '.claude/agents/admin-agent.md',
    mode: 'auto',
  },
  {
    id: 'frontend',
    name: 'Worker1',
    role: 'Frontend / Fullstack',
    icon: 'layout',
    model: 'moonshot-v1-32k',
    heavyModel: 'claude-sonnet-5',
    systemPromptPath: '.claude/agents/frontend-worker.md',
    mode: 'auto',
  },
  {
    id: 'backend',
    name: 'Worker2',
    role: 'Backend / DevOps',
    icon: 'server',
    model: 'moonshot-v1-32k',
    heavyModel: 'claude-sonnet-5',
    systemPromptPath: '.claude/agents/backend-worker.md',
    mode: 'auto',
  },
  {
    id: 'tester',
    name: 'Tester',
    role: 'QA / Security',
    icon: 'bug',
    model: 'moonshot-v1-8k',
    heavyModel: 'claude-sonnet-5',
    systemPromptPath: '.claude/agents/tester-worker.md',
    mode: 'auto',
  },
  {
    id: 'designer',
    name: 'Designer',
    role: 'Интерфейс и типографика',
    icon: 'layout',
    model: 'moonshot-v1-32k',
    heavyModel: 'claude-sonnet-5',
    systemPromptPath: '.claude/agents/designer-agent.md',
    mode: 'auto',
  },
]

/** Провайдер определяется по имени модели — так UI и бэкенд не могут разойтись. */
export function providerForModel(model: string): Provider {
  return model.startsWith('claude') ? 'claude' : 'kimi'
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

let claudeKey = ''
let kimiKey = ''
let economyMode = false
let claudeClient: Anthropic | null = null
let agents: AgentConfig[] | null = null
let settings: AppSettings | null = null

const systemPromptCache = new Map<string, string>()
const activeRequests = new Map<string, AbortController>()

function getSettings(): AppSettings {
  if (!settings) settings = { ...DEFAULT_SETTINGS, ...loadJson<Partial<AppSettings>>(SETTINGS_FILE, {}) }
  return settings
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const prev = getSettings()
  settings = { ...prev, ...patch }
  saveJson(SETTINGS_FILE, settings)
  // Сменился адрес Moonshot — старый список моделей уже не про этот сервер.
  if (patch.kimiBaseUrl && patch.kimiBaseUrl !== prev.kimiBaseUrl) modelsCache.delete('kimi')
  return settings
}

function getAgents(): AgentConfig[] {
  if (!agents) {
    const saved = loadJson<AgentConfig[] | null>(AGENTS_FILE, null)
    // Мержим с дефолтами, чтобы новые поля появлялись у старых конфигов.
    agents = DEFAULT_AGENTS.map((d) => ({ ...d, ...(saved?.find((s) => s.id === d.id) ?? {}) }))
  }
  return agents
}

function persistAgents(): void {
  saveJson(AGENTS_FILE, getAgents())
}

// ---------------------------------------------------------------------------
// Системные промпты
// ---------------------------------------------------------------------------

function loadSystemPrompt(relativePath: string): string {
  const fullPath = path.join(getWorkspaceDir(), relativePath)
  try {
    if (fs.existsSync(fullPath)) return fs.readFileSync(fullPath, 'utf-8')
  } catch {
    /* нет доступа к файлу — используем заглушку ниже */
  }
  return `Ты — ассистент (${relativePath}). Отвечай точно и по делу.`
}

function getCachedSystemPrompt(agentId: string, promptPath: string): string {
  let base = systemPromptCache.get(agentId)
  if (base === undefined) {
    base = loadSystemPrompt(promptPath)
    systemPromptCache.set(agentId, base)
  }
  // Память проекта подмешивается каждый раз: она меняется чаще, чем промпт.
  return getSystemPromptWithMemory(base)
}

export function refreshSystemPrompt(agentId?: string): void {
  if (agentId) systemPromptCache.delete(agentId)
  else systemPromptCache.clear()
}

// ---------------------------------------------------------------------------
// Стоимость и бюджет
// ---------------------------------------------------------------------------

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? FALLBACK_PRICE[providerForModel(model)]
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
}

export function isPriceKnown(model: string): boolean {
  return model in PRICING
}

export function getDailyUsage(): number {
  return getSessionUsage().totalCost
}

export function getDailyBudget(): number {
  return getSettings().dailyBudget
}

/** Возвращает true, если бюджет только что был превышён (для показа модалки). */
function checkBudget(): boolean {
  if (getDailyUsage() >= getDailyBudget() && !economyMode) {
    economyMode = true
    return true
  }
  return false
}

export function isEconomyMode(): boolean {
  return economyMode
}

/** Сбрасывает эконом-режим И счётчик расходов — иначе он включится снова сразу же. */
export function resetEconomyMode(): void {
  economyMode = false
  const { resetSession } = require('./token-tracker') as typeof import('./token-tracker')
  resetSession()
}

// ---------------------------------------------------------------------------
// Ключи и провайдеры
// ---------------------------------------------------------------------------

export function setProviderKeys(claude: string, kimi: string): void {
  const changedClaude = claude.trim() !== claudeKey
  const changedKimi = kimi.trim() !== kimiKey
  claudeKey = claude.trim()
  kimiKey = kimi.trim()
  claudeClient = claudeKey ? new Anthropic({ apiKey: claudeKey }) : null
  // Список моделей зависит от ключа — у другого ключа другой доступ.
  if (changedClaude) modelsCache.delete('claude')
  if (changedKimi) modelsCache.delete('kimi')
  saveKeys(claudeKey, kimiKey)
}

export function getProviderKeys(): { claude: string; kimi: string } {
  return { claude: claudeKey, kimi: kimiKey }
}

export function setProvider(cfg: ProviderConfig): void {
  if (cfg.provider === 'claude') setProviderKeys(cfg.apiKey, kimiKey)
  else setProviderKeys(claudeKey, cfg.apiKey)
}

export function loadPersistedKeys(): void {
  const { claude, kimi } = loadKeys()
  claudeKey = claude
  kimiKey = kimi
  claudeClient = claudeKey ? new Anthropic({ apiKey: claudeKey }) : null
}

function getClaudeClient(): Anthropic {
  if (!claudeClient && claudeKey) claudeClient = new Anthropic({ apiKey: claudeKey })
  if (!claudeClient) throw new Error('Claude API-ключ не установлен')
  return claudeClient
}

export function setAgentMode(agentId: string, mode: AgentMode): void {
  const agent = getAgents().find((a) => a.id === agentId)
  if (agent) {
    agent.mode = mode
    persistAgents()
  }
}

export function setAgentModel(agentId: string, model: string): void {
  const agent = getAgents().find((a) => a.id === agentId)
  if (agent) {
    agent.model = model
    persistAgents()
  }
}

/**
 * Выбирает модель для запроса. Провайдер ВСЕГДА выводится из имени модели,
 * поэтому «Opus, отправленный на эндпоинт Kimi» здесь невозможен.
 */
export function resolveProvider(
  agentId: string,
  forceHeavy = false
): { provider: Provider; model: string } {
  const agent = getAgents().find((a) => a.id === agentId)
  if (!agent) return { provider: 'kimi', model: 'moonshot-v1-32k' }

  let model: string
  if (economyMode) {
    // В эконом-режиме — самая дешёвая доступная модель.
    model = kimiKey ? 'moonshot-v1-8k' : 'claude-haiku-4-5'
  } else if (forceHeavy || agent.mode === 'claude') {
    model = agent.heavyModel
  } else if (agent.mode === 'kimi') {
    model = providerForModel(agent.model) === 'kimi' ? agent.model : 'moonshot-v1-32k'
  } else {
    model = agent.model
  }

  return { provider: providerForModel(model), model }
}

// ---------------------------------------------------------------------------
// Список моделей от провайдера
//
// Захардкоженный список моделей неизбежно устаревает и не знает, к чему
// у конкретного ключа есть доступ. Поэтому спрашиваем сам провайдер —
// у Anthropic и Moonshot для этого есть GET /v1/models.
// ---------------------------------------------------------------------------

const modelsCache = new Map<Provider, { at: number; models: ModelInfo[] }>()
const MODELS_TTL_MS = 10 * 60 * 1000

/**
 * Ошибка HTTP с сохранённым кодом.
 *
 * SDK Anthropic кладёт код в error.status, а обычный fetch — нет. Без этого
 * обёртки обработчики ниже не отличали бы «неверный ключ» от «сеть упала»
 * и показывали бы пользователю сырой JSON провайдера.
 */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

async function fetchClaudeModels(): Promise<ModelInfo[]> {
  const client = getClaudeClient()
  const models: ModelInfo[] = []
  for await (const m of client.models.list({ limit: 100 })) {
    models.push({
      id: m.id,
      label: (m as { display_name?: string }).display_name || m.id,
      provider: 'claude',
      live: true,
    })
  }
  return models
}

async function fetchKimiModels(): Promise<ModelInfo[]> {
  const baseUrl = getSettings().kimiBaseUrl.replace(/\/+$/, '')
  const resp = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${kimiKey}` },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new HttpError(resp.status, body.slice(0, 200))
  }
  const json = (await resp.json()) as { data?: { id?: string }[] }
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, label: id, provider: 'kimi' as const, live: true }))
}

/**
 * Модели одного провайдера. При отсутствии ключа или ошибке сети
 * возвращает встроенный список и текст ошибки — интерфейс остаётся рабочим.
 */
export async function listModels(provider: Provider, force = false): Promise<ModelListResult> {
  const staticFor = STATIC_MODELS.filter((m) => m.provider === provider)
  const key = provider === 'claude' ? claudeKey : kimiKey
  if (!key) return { models: staticFor, error: 'Ключ не задан' }

  const cached = modelsCache.get(provider)
  if (!force && cached && Date.now() - cached.at < MODELS_TTL_MS) {
    return { models: cached.models }
  }

  try {
    const fetched = provider === 'claude' ? await fetchClaudeModels() : await fetchKimiModels()
    if (fetched.length === 0) return { models: staticFor, error: 'Провайдер вернул пустой список' }
    fetched.sort((a, b) => a.id.localeCompare(b.id))
    modelsCache.set(provider, { at: Date.now(), models: fetched })
    return { models: fetched }
  } catch (error) {
    const e = error as { status?: number; message?: string }
    let msg = e.message || 'Не удалось получить список'
    if (e.status === 401 || e.status === 403) msg = 'Ключ отклонён провайдером'
    else if (e.status === 404) msg = 'Эндпоинт не найден — проверьте адрес API'
    else if (e.status === 429) msg = 'Превышен лимит запросов'
    else if (e.status && e.status >= 500) msg = 'Провайдер недоступен'
    return { models: staticFor, error: msg }
  }
}

/** Модели обоих провайдеров разом — для выпадающих списков в настройках. */
export async function listAllModels(force = false): Promise<{
  claude: ModelListResult
  kimi: ModelListResult
}> {
  const [claude, kimi] = await Promise.all([listModels('claude', force), listModels('kimi', force)])
  return { claude, kimi }
}

/** Проверка ключа: самый дешёвый способ — запросить список моделей. */
export async function testKey(provider: Provider): Promise<{ ok: boolean; message: string }> {
  const key = provider === 'claude' ? claudeKey : kimiKey
  if (!key) return { ok: false, message: 'Ключ не задан' }
  const res = await listModels(provider, true)
  if (res.error) return { ok: false, message: res.error }
  return { ok: true, message: `Доступно моделей: ${res.models.length}` }
}

// ---------------------------------------------------------------------------
// Стриминг
// ---------------------------------------------------------------------------

type StreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } }

async function* streamClaude(
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const anthropic = getClaudeClient()
  const stream = anthropic.messages.stream(
    {
      model,
      max_tokens: 16000,
      // cache_control на системном промпте: он большой и стабильный, повторные
      // запросы читают его из кэша примерно за 10% цены.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
    { signal }
  )

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'chunk', text: event.delta.text }
    }
  }

  const final = await stream.finalMessage()
  yield {
    type: 'done',
    usage: {
      inputTokens: final.usage?.input_tokens ?? 0,
      outputTokens: final.usage?.output_tokens ?? 0,
    },
  }
}

async function* streamKimi(
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const baseUrl = getSettings().kimiBaseUrl.replace(/\/+$/, '')
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${kimiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
      // Без этого Moonshot не присылает usage в стриме и расход посчитать нечем.
      stream_options: { include_usage: true },
      temperature: 1,
    }),
    signal,
  })

  if (!resp.ok || !resp.body) {
    const err = await resp.text().catch(() => '')
    throw new HttpError(resp.status, `Moonshot: ${err.slice(0, 300)}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let inputTokens = 0
  let outputTokens = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') {
        yield { type: 'done', usage: { inputTokens, outputTokens } }
        return
      }
      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) yield { type: 'chunk', text: delta }
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens ?? inputTokens
          outputTokens = parsed.usage.completion_tokens ?? outputTokens
        }
      } catch {
        /* неполный / служебный SSE-кадр — пропускаем */
      }
    }
  }

  yield { type: 'done', usage: { inputTokens, outputTokens } }
}

export async function* streamChat(
  agentId: string,
  messages: ChatMessage[],
  forceHeavy = false,
  signal?: AbortSignal,
  /** Дополнение к системному промпту: контекст проекта, задание конвейера, отчёт тестера. */
  extraSystem?: string
): AsyncGenerator<
  | { type: 'chunk'; text: string }
  | {
      type: 'done'
      usage: { inputTokens: number; outputTokens: number; cost: number; budgetTriggered: boolean }
      provider: Provider
      model: string
    }
  | { type: 'error'; message: string }
> {
  const controller = new AbortController()
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  try {
    const agent = getAgents().find((a) => a.id === agentId)
    if (!agent) {
      yield { type: 'error', message: 'Агент не найден' }
      return
    }
    if (messages.length === 0) {
      yield { type: 'error', message: 'Пустой запрос' }
      return
    }

    const { provider, model } = resolveProvider(agentId, forceHeavy)

    if (provider === 'claude' && !claudeKey) {
      yield { type: 'error', message: 'Не задан ключ Anthropic. Настройки → Провайдер: Claude.' }
      return
    }
    if (provider === 'kimi' && !kimiKey) {
      yield { type: 'error', message: 'Не задан ключ Moonshot. Настройки → Провайдер: Kimi.' }
      return
    }

    const base = getCachedSystemPrompt(agentId, agent.systemPromptPath)
    const systemPrompt = extraSystem ? `${base}\n\n${extraSystem}` : base
    const generator =
      provider === 'claude'
        ? streamClaude(model, systemPrompt, messages, controller.signal)
        : streamKimi(model, systemPrompt, messages, controller.signal)

    let inputTokens = 0
    let outputTokens = 0

    for await (const chunk of generator) {
      if (chunk.type === 'done') {
        inputTokens = chunk.usage?.inputTokens ?? 0
        outputTokens = chunk.usage?.outputTokens ?? 0
      } else {
        yield chunk
      }
    }

    const cost = calculateCost(model, inputTokens, outputTokens)
    recordUsage(agentId, agent.name, inputTokens, outputTokens, cost)
    const budgetTriggered = checkBudget()

    yield {
      type: 'done',
      usage: { inputTokens, outputTokens, cost, budgetTriggered },
      provider,
      model,
    }
  } catch (error: unknown) {
    const e = error as { status?: number; name?: string; message?: string }
    let msg = 'Неизвестная ошибка'
    if (e.name === 'AbortError') msg = 'Запрос отменён'
    else if (e.status === 401) msg = 'Невалидный API-ключ'
    else if (e.status === 429) msg = 'Превышен лимит запросов у провайдера'
    else if (e.status === 529) msg = 'Провайдер перегружен, попробуйте ещё раз'
    else if (e.message) msg = e.message
    yield { type: 'error', message: msg }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export function registerAPIIPC(): void {
  ipcMain.handle('api:setKeys', (_e: IpcMainInvokeEvent, claude: string, kimi: string) =>
    setProviderKeys(claude, kimi)
  )
  ipcMain.handle('api:getKeys', () => getProviderKeys())
  ipcMain.handle('api:setProvider', (_e: IpcMainInvokeEvent, cfg: ProviderConfig) =>
    setProvider(cfg)
  )
  ipcMain.handle('api:getKeyStatus', () => ({
    claude: Boolean(claudeKey),
    kimi: Boolean(kimiKey),
    persistent: isEncryptionAvailable(),
  }))

  ipcMain.handle('api:getAgents', () =>
    getAgents().map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      icon: a.icon,
      model: a.model,
      heavyModel: a.heavyModel,
      mode: a.mode,
    }))
  )
  ipcMain.handle('api:listModels', (_e: IpcMainInvokeEvent, force?: boolean) =>
    listAllModels(Boolean(force))
  )
  ipcMain.handle('api:testKey', (_e: IpcMainInvokeEvent, provider: Provider) => testKey(provider))
  ipcMain.handle('api:isPriceKnown', (_e: IpcMainInvokeEvent, model: string) => isPriceKnown(model))
  ipcMain.handle('api:setAgentMode', (_e: IpcMainInvokeEvent, id: string, mode: AgentMode) =>
    setAgentMode(id, mode)
  )
  ipcMain.handle('api:setAgentModel', (_e: IpcMainInvokeEvent, id: string, model: string) =>
    setAgentModel(id, model)
  )

  ipcMain.handle('api:getUsage', () => ({
    daily: getDailyUsage(),
    budget: getDailyBudget(),
    economyMode: isEconomyMode(),
  }))
  ipcMain.handle('api:resetEconomy', () => resetEconomyMode())
  ipcMain.handle('api:getSettings', () => getSettings())
  ipcMain.handle('api:updateSettings', (_e: IpcMainInvokeEvent, p: Partial<AppSettings>) =>
    updateSettings(p)
  )

  ipcMain.handle('tracker:getSession', () => getSessionUsage())
  ipcMain.handle('tracker:getAgent', (_e: IpcMainInvokeEvent, id: string) => {
    const { getAgentUsage } = require('./token-tracker') as typeof import('./token-tracker')
    return getAgentUsage(id)
  })
  ipcMain.handle('tracker:reset', () => {
    const { resetSession } = require('./token-tracker') as typeof import('./token-tracker')
    resetSession()
  })

  ipcMain.handle('prompts:list', () => {
    const { listAgentFiles } = require('./file-manager') as typeof import('./file-manager')
    return listAgentFiles()
  })
  ipcMain.handle('prompts:read', (_e: IpcMainInvokeEvent, p: string) => {
    const { readFile } = require('./file-manager') as typeof import('./file-manager')
    return readFile(p)
  })
  ipcMain.handle('prompts:write', (_e: IpcMainInvokeEvent, p: string, content: string) => {
    const { writeFile } = require('./file-manager') as typeof import('./file-manager')
    const ok = writeFile(p, content)
    // Промпт агента изменился — сбрасываем кэш, чтобы правка применилась сразу.
    if (ok) {
      const normalized = p.split('\\').join('/')
      const agent = getAgents().find((a) => normalized.endsWith(a.systemPromptPath))
      refreshSystemPrompt(agent?.id)
    }
    return ok
  })
  ipcMain.handle('prompts:create', (_e: IpcMainInvokeEvent, name: string) => {
    const { createAgentFile } = require('./file-manager') as typeof import('./file-manager')
    return createAgentFile(name)
  })
  ipcMain.handle('prompts:delete', (_e: IpcMainInvokeEvent, p: string) => {
    const { deleteAgentFile } = require('./file-manager') as typeof import('./file-manager')
    return deleteAgentFile(p)
  })

  ipcMain.on(
    'api:streamChat',
    async (
      event,
      requestId: string,
      agentId: string,
      messages: ChatMessage[],
      forceHeavy = false
    ) => {
      const controller = new AbortController()
      activeRequests.set(requestId, controller)
      try {
        for await (const chunk of streamChat(agentId, messages, forceHeavy, controller.signal)) {
          if (event.sender.isDestroyed()) break
          event.sender.send('api:streamChunk', requestId, chunk)
        }
      } catch (error: unknown) {
        if (!event.sender.isDestroyed()) {
          event.sender.send('api:streamChunk', requestId, {
            type: 'error',
            message: (error as Error)?.message || 'Ошибка потока',
          })
        }
      } finally {
        activeRequests.delete(requestId)
      }
    }
  )

  ipcMain.handle('api:abortChat', (_e: IpcMainInvokeEvent, requestId: string) => {
    activeRequests.get(requestId)?.abort()
    activeRequests.delete(requestId)
  })
}
