import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  streamChat,
  getDailyUsage,
  getDailyBudget,
  type ChatMessage as ApiMessage,
} from './api-client'
import { appendMessage, type ChatMessage as StoredMessage } from './chat-store'
import { getActiveProjectId, getProjectDir } from './projects'
import {
  buildProjectContext,
  listProjectFiles,
  readFileForContext,
  type DeliveryKind,
} from './code-context'
import { runChecks, type CheckReport } from './command-runner'
import { stopPreviewForProject } from './live-preview'
import { applyScaffold } from './scaffold'
import {
  runRuntimeCheck,
  stopRuntimeCheck,
  type PageSnapshot,
  type RuntimeReport,
  type RuntimeProgressEvent,
  type ScenarioStep,
} from './runtime-check'
import { describeLayout, type LayoutReport } from './layout-audit'
import { getDataDir } from './paths'
import { writeProjectFile } from './file-ops'
import { parseFileBlocks } from '../shared/code-blocks'
import { addTask, updateSubtask, type TaskTree } from './decomposition'
import { loadJson, saveJson } from './persistence'
import { ensureRepo, snapshot } from './git-snapshot'
import {
  MAX_SUBTASKS,
  extractJson,
  parseAnalysisOutcome,
  renderAnalysis,
  renderClarification,
  parsePlan,
  renderPlan,
  AGENT_NAME,
  indexOfMention,
  extractRequestedFiles,
  extractCritical,
} from './pipeline-parsing'

/**
 * Конвейер: одна задача на входе — готовый проверенный проект на выходе.
 *
 * Analyst первым оценивает задачу в процентах (довезёт ли конвейер до
 * результата, какую долю объёма закроет сам) — пользователь решает, делать
 * задачу вообще или нет. Если да, Admin разбивает её на подзадачи, и
 * пользователь утверждает план — это две остановки конвейера, обе гейты
 * (`awaiting_analysis`, `awaiting_plan`). Дальше воркеры пишут код, он
 * сохраняется в файлы проекта, Тестер прогоняет реальную сборку, и при
 * провале ошибки возвращаются воркеру на исправление — без остановок.
 *
 * Живёт в main-процессе намеренно: renderer перерисовывается, переключает
 * проекты и панели — конвейер не должен от этого умирать.
 */

// Типы конвейера живут в src/shared/pipeline.ts — main, preload и renderer
// импортируют их из одного места вместо трёх ручных копий.
export type {
  PipelineStatus,
  Assignee,
  PipelineAnalysis,
  PipelineSubtask,
  PipelineLogEntry,
  PipelineRun,
} from '../shared/pipeline'
import type {
  PipelineStatus,
  Assignee,
  PipelineAnalysis,
  PipelineSubtask,
  PipelineLogEntry,
  PipelineRun,
} from '../shared/pipeline'

const MAX_FIX_ATTEMPTS = 3
/** Журнал пишется на диск целиком — без потолка файл рос бы бесконечно. */
const MAX_LOG_ENTRIES = 500

const RUNS_FILE = 'pipeline.json'
const HISTORY_FILE = 'pipeline-history.json'
/** Не больше стольких прошлых прогонов на проект — дальше старые вытесняются новыми. */
const MAX_HISTORY_PER_PROJECT = 10

/** Статусы, при которых конвейер реально что-то делает прямо сейчас. */
const BUSY: PipelineStatus[] = ['analyzing', 'planning', 'working', 'verifying', 'fixing']
const FINAL: PipelineStatus[] = ['done', 'unverified', 'failed', 'stopped', 'interrupted']
/** Гейты — прогон ждёт решения пользователя и переживает перезапуск приложения. */
const GATES: PipelineStatus[] = ['awaiting_clarification', 'awaiting_analysis', 'awaiting_plan']

/** projectId -> последний прогон этого проекта. */
type RunsFile = Record<string, PipelineRun>

let store: RunsFile | null = null
let run: PipelineRun | null = null
let getWindow: () => BrowserWindow | null = () => null
let abort: AbortController | null = null
let stopRequested = false

/**
 * Поднимает прогоны с диска. Прогон, застигнутый закрытием приложения посреди
 * работы, помечается прерванным: показывать «выполняется» для того, что уже
 * никто не выполняет, — прямая ложь пользователю.
 *
 * Исключение — гейты (`awaiting_analysis`, `awaiting_plan`): ответ уже
 * оплачен и лежит целиком, гейт можно пройти и после перезапуска, поэтому
 * такой прогон восстанавливается живым.
 */
function loadRuns(): RunsFile {
  if (store) return store
  store = loadJson<RunsFile>(RUNS_FILE, {})

  let resumable: PipelineRun | null = null
  let dirty = false
  for (const r of Object.values(store)) {
    // Файл могли обрезать на записи при выключении питания или поправить
    // руками: пустой массив здесь дешевле, чем падение окна на старте.
    if (!Array.isArray(r.log)) r.log = []
    if (!Array.isArray(r.subtasks)) r.subtasks = []
    if (BUSY.includes(r.status)) {
      r.status = 'interrupted'
      r.finishedAt = r.finishedAt ?? Date.now()
      r.log.push({ at: Date.now(), kind: 'err', text: 'Прогон прерван закрытием приложения' })
      dirty = true
      continue
    }
    if (GATES.includes(r.status)) {
      if (!resumable || r.startedAt > resumable.startedAt) resumable = r
    }
  }
  if (dirty) saveJson(RUNS_FILE, store)
  // Только один прогон может ждать утверждения: гейт — модальное окно.
  if (resumable) run = resumable
  return store
}

/** Прогон нужного проекта (по умолчанию — активного). */
export function getRun(projectId?: string): PipelineRun | null {
  return loadRuns()[projectId ?? getActiveProjectId()] ?? null
}

/** projectId -> прошлые (завершённые) прогоны этого проекта, старые первыми. */
type HistoryFile = Record<string, PipelineRun[]>

let history: HistoryFile | null = null

function loadHistory(): HistoryFile {
  if (!history) history = loadJson<HistoryFile>(HISTORY_FILE, {})
  return history
}

/**
 * Уносит прогон проекта в историю перед тем, как его заменят новым —
 * `pipeline.json` всегда хранит только последний прогон, а без этого
 * решение Analyst, план Admin и лог предыдущего заказа исчезали бы
 * бесследно в момент запуска следующего.
 */
function archiveIfFinal(projectId: string): void {
  const prior = loadRuns()[projectId]
  if (!prior || !FINAL.includes(prior.status)) return

  const h = loadHistory()
  const list = h[projectId] ?? []
  list.push(prior)
  if (list.length > MAX_HISTORY_PER_PROJECT) list.shift()
  h[projectId] = list
  saveJson(HISTORY_FILE, h)
}

/** Прошлые прогоны проекта, новые последними — для панели истории. */
export function getRunHistory(projectId?: string): PipelineRun[] {
  return loadHistory()[projectId ?? getActiveProjectId()] ?? []
}

function persist(): void {
  if (!run) return
  const runs = loadRuns()
  runs[run.projectId] = run
  saveJson(RUNS_FILE, runs)
}

function emit(): void {
  persist()
  // Окно могло закрыться посреди работы конвейера — конвейер живёт в main и
  // это переживает, но отправка в уничтоженный webContents бросает исключение.
  const win = getWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  // Пользователь мог уйти в другой проект: показываем прогон того проекта,
  // который открыт, а не тот, что работает.
  win.webContents.send('pipeline:update', getRun())
}

function log(kind: PipelineLogEntry['kind'], text: string, agent?: string): void {
  if (!run) return
  run.log.push({ at: Date.now(), kind, text, agent })
  if (run.log.length > MAX_LOG_ENTRIES) run.log = run.log.slice(-MAX_LOG_ENTRIES)
  emit()
}

function setStatus(status: PipelineStatus): void {
  if (!run) return
  run.status = status
  if (FINAL.includes(status)) run.finishedAt = Date.now()
  emit()
}

// ---------------------------------------------------------------------------
// Вызов агента
// ---------------------------------------------------------------------------

interface AgentReply {
  text: string
  error?: string
}

/**
 * Один запрос к агенту с записью в его чат — чтобы всё, что сделал конвейер,
 * было видно в интерфейсе обычными диалогами, а не только в журнале.
 */
async function callAgent(
  agentId: string,
  userText: string,
  extraSystem?: string,
  /** false — ответ не пишется в чат: у плана это сырой JSON, вместо него кладём читаемую версию. */
  recordReply = true
): Promise<AgentReply> {
  const projectId = run?.projectId
  const stamp = Date.now()

  appendMessage(
    agentId,
    { id: `p-u-${stamp}`, sender: 'user', text: userText, timestamp: stamp } as StoredMessage,
    projectId
  )

  const messages: ApiMessage[] = [{ role: 'user', content: userText }]
  abort = new AbortController()

  let out = ''
  let error: string | undefined
  let model: string | undefined
  let provider: 'claude' | 'kimi' | undefined

  for await (const chunk of streamChat(agentId, messages, false, abort.signal, extraSystem)) {
    if (chunk.type === 'chunk') out += chunk.text
    else if (chunk.type === 'error') error = chunk.message
    else {
      model = chunk.model
      provider = chunk.provider
    }
  }
  abort = null

  const text = out.trim()
  if (text && recordReply) {
    appendMessage(
      agentId,
      {
        id: `p-a-${Date.now()}`,
        sender: 'agent',
        text,
        timestamp: Date.now(),
        model,
        provider,
      } as StoredMessage,
      projectId
    )
  }
  return { text, error }
}

/** Останавливает конвейер, если деньги кончились: автономный цикл иначе выжжет бюджет. */
function budgetExhausted(): boolean {
  return getDailyUsage() >= getDailyBudget()
}

// ---------------------------------------------------------------------------
// Анализ выполнимости от Analyst
// ---------------------------------------------------------------------------

const ANALYSIS_INSTRUCTION = `## Формат этого ответа

Сейчас ты работаешь в автоматическом конвейере, на самом первом его шаге —
до Admin и до плана. Конвейер умеет: Admin планирует и координирует,
Worker1 — фронтенд и клиент, Worker2 — бэкенд, БД и инфраструктура,
Tester прогоняет сборку/тесты и проверяет качество, Designer правит
оформление уже поднятого приложения. За пределы кода в папке проекта (живые
переговоры, юридическое сопровождение, реальные деньги, физические действия,
доступы и учётные записи в сторонних сервисах) конвейер не выходит.

Если данных достаточно, чтобы оценить задачу честно, ответь ТОЛЬКО
JSON-объектом, без пояснений до и после, без markdown-ограды, строго такой
структуры:

{
  "feasibility": 0-100,
  "coverage": 0-100,
  "missing": ["конкретный пункт того, чего не хватает"],
  "summary": "короткое обоснование в 2-4 предложения"
}

Правила:
- feasibility — вероятность довести задачу до рабочего результата без
  критических провалов;
- coverage — сколько процентов объёма самой задачи конвейер реально закроет
  своими силами (остальное — то, что придётся делать не конвейером);
- missing — конкретные пункты, а не общие фразы; пустой массив, если нехватки нет;
- если задача полностью в возможностях конвейера, feasibility и coverage — 100,
  missing — пустой массив.

Если же без ключевой детали оценка станет гаданием (например, не сказано,
идёт ли речь о вебе или десктопе, нужна ли оплата и т.п.) — вместо оценки
задай ОДИН уточняющий вопрос, ответив строго:

{ "question": "твой вопрос одним предложением" }

Уточняй только когда это реально меняет цифры; по умолчанию оценивай сразу.
Задать вопрос можно не больше одного раза за этот запуск — дальше отвечай
только числами, по имеющимся данным, пусть и приблизительно.`

/**
 * Один шаг диалога с Analyst: либо готовая оценка, либо просьба уточнить.
 *
 * allowClarify=false — уже был один раунд уточнения, дальше только числа: если
 * модель снова просит уточнение, это считается невалидным ответом и уходит на
 * повторную попытку общего цикла, как и любой не-JSON ответ.
 */
async function doAnalysis(prompt: string, allowClarify: boolean): Promise<'done' | 'clarify' | 'failed'> {
  setStatus('analyzing')
  log('info', 'Аналитик оценивает выполнимость задачи', 'analyst')

  const context = buildProjectContext({
    keywords: prompt.split(/\s+/),
    projectId: run?.projectId,
  })
  const extra = context ? `${context}\n\n${ANALYSIS_INSTRUCTION}` : ANALYSIS_INSTRUCTION

  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await callAgent('analyst', prompt, extra, false)
    if (reply.error) {
      log('err', `Ошибка запроса к Analyst: ${reply.error}`, 'analyst')
      return 'failed'
    }
    const outcome = parseAnalysisOutcome(reply.text)

    if (outcome?.kind === 'analysis' && run) {
      run.analysis = outcome.value
      run.clarification = null
      appendMessage(
        'analyst',
        {
          id: `p-analysis-${Date.now()}`,
          sender: 'agent',
          text: renderAnalysis(outcome.value),
          timestamp: Date.now(),
        } as StoredMessage,
        run.projectId
      )
      log(
        'ok',
        `Анализ готов: выполнимость ${outcome.value.feasibility}%, покрытие ${outcome.value.coverage}%`,
        'analyst'
      )
      return 'done'
    }

    if (outcome?.kind === 'clarification' && allowClarify && run) {
      run.clarification = { question: outcome.value.question, answer: null }
      appendMessage(
        'analyst',
        {
          id: `p-clarify-${Date.now()}`,
          sender: 'agent',
          text: renderClarification(outcome.value.question),
          timestamp: Date.now(),
        } as StoredMessage,
        run.projectId
      )
      log('info', `Аналитику нужно уточнение: ${outcome.value.question}`, 'analyst')
      return 'clarify'
    }

    log(
      'err',
      attempt === 1
        ? 'Analyst вернул не JSON — повторяю запрос'
        : 'Analyst повторно вернул не JSON, анализ не построен',
      'analyst'
    )
  }
  return 'failed'
}

// ---------------------------------------------------------------------------
// План от Admin
// ---------------------------------------------------------------------------

const PLAN_INSTRUCTION = `## Формат этого ответа

Сейчас ты работаешь в автоматическом конвейере. Ответь ТОЛЬКО JSON-объектом,
без пояснений до и после, без markdown-ограды, строго такой структуры:

{
  "stack": "краткое описание выбранного стека",
  "subtasks": [
    { "title": "короткое название", "description": "что именно сделать, какие файлы создать", "assignee": "frontend" }
  ]
}

Правила:
- assignee только "frontend" (UI, React, клиент) или "backend" (API, БД, инфраструктура);
- подзадачи идут в порядке выполнения: то, от чего зависят другие, — раньше;
- не более ${MAX_SUBTASKS} подзадач, каждая — законченный кусок работы;
- в description укажи конкретные пути файлов, которые надо создать или изменить;
- не пиши код — только план;
- для backend выбирай стек по задаче, а не только Express по умолчанию:
  Express+CORS, FastAPI/Django (Python) и PHP/Laravel — все три одинаково
  поддержаны проверкой сборки и «Просмотром»;
- если стек — Vite+React+TS+Tailwind на фронтенде и/или Express+CORS/FastAPI
  на бэкенде с раскладкой по подпапкам frontend/ и backend/ (пути в
  description начинаются с этих префиксов) — в этих подпапках уже будет
  готовый базовый каркас конфигурации к моменту первой подзадачи, не
  закладывай отдельную подзадачу на "настройку проекта". Для PHP/Laravel
  или без такой раскладки это правило не действует — каркас не готов
  заранее, начинай с обычной установки фреймворка.`

// ---------------------------------------------------------------------------
// Этапы
// ---------------------------------------------------------------------------

async function doPlanning(goal: string): Promise<boolean> {
  setStatus('planning')
  log('info', 'Admin составляет план работ', 'admin')

  const context = buildProjectContext({
    keywords: goal.split(/\s+/),
    projectId: run?.projectId,
  })
  const extra = context ? `${context}\n\n${PLAN_INSTRUCTION}` : PLAN_INSTRUCTION

  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await callAgent('admin', goal, extra, false)
    if (reply.error) {
      log('err', `Ошибка запроса к Admin: ${reply.error}`, 'admin')
      return false
    }
    const plan = parsePlan(reply.text)
    if (plan && run) {
      run.stack = plan.stack
      run.subtasks = plan.subtasks
      appendMessage(
        'admin',
        {
          id: `p-plan-${Date.now()}`,
          sender: 'agent',
          text: renderPlan(plan.stack, plan.subtasks),
          timestamp: Date.now(),
        } as StoredMessage,
        run.projectId
      )
      log('ok', `План готов: ${plan.subtasks.length} подзадач`, 'admin')
      return true
    }
    log(
      'err',
      attempt === 1
        ? 'Admin вернул не JSON — повторяю запрос'
        : 'Admin повторно вернул не JSON, план не построен',
      'admin'
    )
  }
  return false
}

const WORKER_FORMAT = `## Формат этого ответа

Ты работаешь в автоматическом конвейере: всё, что ты пришлёшь в блоке кода с
указанием пути, будет СРАЗУ записано в файл проекта. Поэтому:
- присылай ПОЛНОЕ содержимое каждого файла, а не фрагмент и не диff;
- каждый файл — отдельный блок с путём от корня проекта:
  \`\`\`ts path=src/server/index.ts
  ...полное содержимое...
  \`\`\`
- никаких пояснений вне блоков кода;
- если файл уже существует в контексте выше — присылай его новую версию целиком;
- трогай только файлы своей подзадачи: чужие файлы из контекста не переписывай,
  даже если тебе кажется, что их стоит улучшить;
- если для работы не хватает файла, которого нет в контексте, — не выдумывай его
  содержимое: назови нужные файлы ОДНОЙ строкой и не присылай код вообще, их
  дошлют и запрос повторят.`

async function doSubtask(sub: PipelineSubtask): Promise<boolean> {
  if (!run) return false
  sub.status = 'in_progress'
  if (run.taskId) updateSubtask(run.taskId, sub.id, { status: 'in_progress' })
  log('info', `${sub.title}`, sub.assignee)
  emit()

  const done = run.subtasks
    .filter((s) => s.status === 'done')
    .map((s) => `- ${s.title} (файлы: ${s.files.join(', ') || 'нет'})`)
    .join('\n')

  const keywords = `${sub.title} ${sub.description}`.split(/\s+/)
  const context = buildProjectContext({ keywords, projectId: run.projectId })

  const extra = [context, WORKER_FORMAT].filter(Boolean).join('\n\n')
  const task = [
    `# Общая цель проекта`,
    run.goal,
    run.stack ? `\nСтек: ${run.stack}` : '',
    done ? `\n# Уже сделано\n${done}` : '',
    `\n# Твоя подзадача`,
    sub.title,
    sub.description,
  ]
    .filter(Boolean)
    .join('\n')

  let reply = await callAgent(sub.assignee, task, extra)
  if (reply.error) {
    sub.status = 'failed'
    log('err', `Ошибка: ${reply.error}`, sub.assignee)
    return false
  }

  let blocks = parseFileBlocks(reply.text)

  // Ответ без кода — ещё не провал: воркеру могло не хватить файла. Один раунд
  // уточнения дешевле, чем потерянная подзадача и ручная доделка за конвейером.
  if (blocks.length === 0) {
    const known = listProjectFiles(run.projectId).map((f) => f.path)
    const requested = extractRequestedFiles(reply.text, known)
    if (requested.length === 0) {
      sub.status = 'failed'
      log('err', 'Агент не прислал ни одного файла с указанием пути', sub.assignee)
      return false
    }

    // Говорим ровно то, что произошло: раньше здесь было «досылаю» даже для
    // файлов, содержимое которых прочесть нечем, и пропажу было не видно.
    const projectId = run.projectId
    const delivery = requested.map((f) => ({
      path: f,
      kind: readFileForContext(f, projectId)?.kind ?? 'binary',
    }))
    const label = (k: DeliveryKind): string =>
      k === 'converted' ? ' (таблица — превью)' : k === 'binary' ? ' (двоичный — только описание)' : ''
    log(
      'info',
      `Просит файлы: ${delivery.map((d) => d.path + label(d.kind)).join(', ')} — досылаю`,
      sub.assignee
    )
    const extra2 = [
      buildProjectContext({ keywords, projectId: run.projectId, include: requested }),
      WORKER_FORMAT,
    ]
      .filter(Boolean)
      .join('\n\n')
    reply = await callAgent(
      sub.assignee,
      `${task}\n\n# Запрошенные файлы досланы\n${requested.join(', ')} — они целиком в контексте выше. Присылай код.`,
      extra2
    )
    if (reply.error) {
      sub.status = 'failed'
      log('err', `Ошибка: ${reply.error}`, sub.assignee)
      return false
    }
    blocks = parseFileBlocks(reply.text)
    if (blocks.length === 0) {
      sub.status = 'failed'
      log('err', 'Файлы досланы, но кода так и нет', sub.assignee)
      return false
    }
  }

  for (const b of blocks) {
    // Живой прогон показал: воркер охотно правит чужие файлы. Запретить нельзя —
    // иногда это законно, но в журнале это должно быть видно.
    const owner = run.subtasks.find((s) => s !== sub && s.files.includes(b.path))
    if (owner) log('info', `${b.path} переписан поверх «${owner.title}»`, sub.assignee)

    const res = writeProjectFile(b.path, b.code, run.projectId)
    if (res.ok) {
      if (!sub.files.includes(b.path)) sub.files.push(b.path)
      log('ok', `Записан ${b.path}`, sub.assignee)
    } else {
      log('err', `Не записан ${b.path}: ${res.message ?? 'ошибка'}`, sub.assignee)
    }
  }

  sub.status = sub.files.length > 0 ? 'done' : 'failed'
  if (run.taskId) {
    updateSubtask(run.taskId, sub.id, { status: sub.status === 'done' ? 'done' : 'blocked' })
  }
  emit()
  return sub.status === 'done'
}

const TESTER_FORMAT = `## Формат этого ответа

Ты работаешь в автоматическом конвейере. Сборка и тесты уже прогнаны, их вывод
приведён выше — он и есть объективный результат. От тебя нужен короткий отчёт
по качеству и безопасности кода, не более 15 строк, каждая строка начинается
с метки [CRITICAL], [WARNING] или [OK]. Код не присылай.

Метка [CRITICAL] запускает автоматическую переделку кода воркером, поэтому
ставь её только там, где проект не выполняет заявленную задачу, теряет данные
или содержит настоящую уязвимость. Стиль, форматирование, отсутствие тестов и
пожелания на будущее — это [WARNING].
Если критических дефектов нет, ни одной строки с [CRITICAL] быть не должно.`

const SCENARIO_INSTRUCTION = `## Формат этого ответа

Приложение уже запущено, страница открыта в браузере. Опиши ОДИН главный
пользовательский сценарий — тот, ради которого приложение написано, — списком
шагов, которые за тебя проиграют.

Ответь ТОЛЬКО JSON-массивом, без пояснений и без markdown-ограды:

[
  { "action": "fill", "selector": "#input-id", "value": "текст" },
  { "action": "click", "selector": "#button-id" },
  { "action": "waitFor", "selector": ".item" },
  { "action": "expectText", "value": "текст" }
]

Правила:
- селекторы бери ТОЛЬКО из списка элементов выше, не придумывай свои;
- допустимые действия: fill, click, waitFor, expectText, expectChecked, expectEnabled;
- у fill и expectText обязательно поле value, у остальных — selector;
- не больше 8 шагов, и хотя бы один из них — проверка результата
  (expectText, expectChecked или expectEnabled);
- проверяй то, что обещано в цели проекта, а не то, чего никто не просил.`

/** Максимум шагов: длинный сценарий чаще ломается сам, чем ловит дефект. */
const MAX_SCENARIO_STEPS = 8

const SCENARIO_ACTIONS = ['fill', 'click', 'waitFor', 'expectText', 'expectChecked', 'expectEnabled']

/**
 * Разбирает сценарий, присланный Тестером.
 *
 * Проверка строгая намеренно: шаги уходят в исполнение на странице, поэтому
 * всё, что не опознано дословно, отбрасывается. Модель присылает данные, а не
 * код, и никакой текст от неё в браузере не выполняется.
 */
function parseScenario(text: string): ScenarioStep[] {
  const json = extractJson(text, '[', ']')
  if (!json) return []

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const steps: ScenarioStep[] = []
  for (const item of raw.slice(0, MAX_SCENARIO_STEPS)) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const action = typeof s.action === 'string' ? s.action : ''
    if (!SCENARIO_ACTIONS.includes(action)) continue

    const selector = typeof s.selector === 'string' ? s.selector.trim() : ''
    const value = typeof s.value === 'string' ? s.value : ''

    if (action === 'expectText') {
      if (value) steps.push({ action: 'expectText', value })
      continue
    }
    if (!selector) continue
    if (action === 'fill') {
      if (value) steps.push({ action: 'fill', selector, value })
      continue
    }
    if (action === 'click') steps.push({ action: 'click', selector })
    else if (action === 'waitFor') steps.push({ action: 'waitFor', selector })
    else if (action === 'expectChecked') steps.push({ action: 'expectChecked', selector })
    else if (action === 'expectEnabled') steps.push({ action: 'expectEnabled', selector })
  }

  // Сценарий без единой проверки ничего не доказывает: заполнить поле и нажать
  // кнопку можно и в сломанном приложении.
  const hasCheck = steps.some((s) => s.action.startsWith('expect'))
  return hasCheck ? steps : []
}

/** Просит Тестера описать главный пользовательский путь по тому, что видно на странице. */
async function askTesterForScenario(page: PageSnapshot): Promise<ScenarioStep[]> {
  if (!run) return []

  const elements = page.elements
    .map((e) => {
      const parts = [`${e.selector} — ${e.tag}`]
      if (e.type) parts.push(`тип ${e.type}`)
      if (e.placeholder) parts.push(`подсказка «${e.placeholder}»`)
      if (e.text) parts.push(`текст «${e.text}»`)
      if (e.disabled) parts.push('отключён')
      return `- ${parts.join(', ')}`
    })
    .join('\n')

  const reply = await callAgent(
    'tester',
    [
      `# Цель проекта\n${run.goal}`,
      `\n# Страница ${page.url}\nЗаголовок: ${page.title || '(нет)'}`,
      `\n# Элементы страницы\n${elements || '(интерактивных элементов не найдено)'}`,
      `\n# Разметка (начало)\n\`\`\`html\n${page.html.slice(0, 2500)}\n\`\`\``,
    ].join('\n'),
    SCENARIO_INSTRUCTION
  )
  if (reply.error) {
    log('info', `Сценарий не составлен: ${reply.error}`, 'tester')
    return []
  }

  const steps = parseScenario(reply.text)
  if (steps.length === 0) log('info', 'Тестер не прислал разборчивого сценария', 'tester')
  else log('info', `Сценарий из ${steps.length} шагов — проигрываю`, 'tester')
  return steps
}

const DESIGN_INSTRUCTION = `## Формат этого ответа

Приложение запущено, страница открыта, мерки сняты. Исправь оформление по
замечаниям ниже — и только оформление.

- присылай ПОЛНОЕ содержимое каждого изменённого файла блоком с путём:
  \`\`\`css path=public/style.css
  ...полное содержимое...
  \`\`\`
- никаких пояснений вне блоков кода;
- логику не трогай: обработчики, запросы, имена id и классов, по которым
  цепляется скрипт, должны остаться прежними — иначе приложение сломается;
- меняй минимум файлов, обычно достаточно одного файла стилей;
- ничего не подключай из интернета: ни шрифтов, ни библиотек, ни картинок.

Каждое замечание ниже снято измерением, а не на глаз. После твоей правки
страницу перечитают и обмеряют заново, поэтому отвечать общими словами
бессмысленно — считаться будет результат.`

/**
 * Отдаёт замечания дизайнеру и записывает присланные файлы.
 *
 * Возвращает true, только если что-то действительно записано: механика по
 * этому признаку решает, перечитывать ли страницу и снимать ли мерки заново.
 */
async function askDesigner(page: PageSnapshot, report: LayoutReport): Promise<boolean> {
  if (!run) return false

  log('info', `Замечаний по вёрстке: ${report.findings.length} — отдаю дизайнеру`, 'designer')

  const context = buildProjectContext({
    keywords: ['css', 'style', 'index.html', 'app.js'],
    projectId: run.projectId,
  })
  const task = [
    `# Цель проекта\n${run.goal}`,
    `\n# Что измерено на странице ${page.url}\n${describeLayout(report)}`,
    `\n# Состав страницы\n${page.html.slice(0, 3000)}`,
  ].join('\n')

  const reply = await callAgent('designer', task, [context, DESIGN_INSTRUCTION].filter(Boolean).join('\n\n'))
  if (reply.error) {
    log('err', `Ошибка запроса к дизайнеру: ${reply.error}`, 'designer')
    return false
  }

  const blocks = parseFileBlocks(reply.text)
  if (blocks.length === 0) {
    log('info', 'Дизайнер не прислал файлов', 'designer')
    return false
  }

  let wrote = false
  for (const b of blocks) {
    const res = writeProjectFile(b.path, b.code, run.projectId)
    if (res.ok) {
      wrote = true
      log('ok', `Оформление: обновлён ${b.path}`, 'designer')
    } else {
      log('err', `Не записан ${b.path}: ${res.message ?? 'ошибка'}`, 'designer')
    }
  }
  return wrote
}

/** Куда класть снимок готовой страницы: рядом с данными приложения, не в проект. */
function screenshotPathFor(projectId: string): string {
  return path.join(getDataDir(), 'previews', `${projectId}.png`)
}

/** Не больше стольких кадров в мини-истории — дальше старые вытесняются новыми. */
const SCREENSHOT_HISTORY_SIZE = 4

function screenshotHistoryDir(): string {
  return path.join(getDataDir(), 'previews', 'history')
}

/** Результат приёмки: сборка, работающее приложение и ревью Тестера. */
interface Verdict {
  report: CheckReport
  /** Строки отчёта с меткой [CRITICAL] — блокируют приёмку. */
  critical: string[]
  /** Итог «подними и постучись»: null, если до него не дошло. */
  runtime: RuntimeReport | null
}

/**
 * Транслирует промежуточные события «подними и постучись» в уже существующий
 * канал лога/скриншота конвейера — без этого пользователь не видел ничего
 * между «Запуск приложения» и итоговым результатом 30–90 секунд спустя.
 */
function onRuntimeProgress(e: RuntimeProgressEvent): void {
  if (!run) return
  switch (e.kind) {
    case 'starting':
      log('info', `Запускаю приложение: ${e.command}`, 'tester')
      break
    case 'up':
      log('ok', `Приложение отвечает: ${e.url}`, 'tester')
      break
    case 'opening':
      log('info', 'Открываю страницу в браузере', 'tester')
      break
    case 'step':
      log(
        e.ok === null ? 'info' : e.ok ? 'ok' : 'err',
        `Шаг ${e.index}/${e.total}: ${e.description}`,
        'tester'
      )
      break
    case 'screenshot': {
      run.screenshot = e.path
      // Мини-история — удобство, а не гарантия: любая ошибка диска здесь не
      // должна останавливать саму проверку.
      try {
        const dir = screenshotHistoryDir()
        fs.mkdirSync(dir, { recursive: true })
        const histPath = path.join(dir, `${run.projectId}-${Date.now()}.png`)
        fs.copyFileSync(e.path, histPath)
        const history = [...run.screenshotHistory, histPath]
        while (history.length > SCREENSHOT_HISTORY_SIZE) {
          const removed = history.shift()
          if (removed) fs.rm(removed, () => undefined)
        }
        run.screenshotHistory = history
      } catch {
        /* история не сложилась — не мешаем проверке */
      }
      emit()
      break
    }
    case 'design_start':
      log('info', 'Дизайнер получил замечания по вёрстке', 'designer')
      break
    case 'design_done':
      log(e.wrote ? 'ok' : 'info', e.wrote ? 'Дизайнер обновил файлы' : 'Дизайнер не прислал файлов', 'designer')
      break
  }
}

async function doVerify(): Promise<Verdict> {
  setStatus('verifying')
  log('info', 'Прогон сборки и тестов', 'tester')

  // Ручной dev-сервер «Просмотра» может держать файлы того же проекта открытыми
  // (esbuild.exe и т.п. на Windows) — если не остановить его здесь, npm ci
  // ниже падает по EPERM, и конвейер тратит попытки на пустом месте.
  if (run) stopPreviewForProject(run.projectId)

  const projectDir = run ? getProjectDir(run.projectId) : undefined
  const report = await runChecks(projectDir)
  if (!run) return { report, critical: [], runtime: null }

  run.checks = { ran: report.ran, passed: report.passed, summary: report.summary }
  log(
    report.ran ? (report.passed ? 'ok' : 'err') : 'info',
    report.ran
      ? report.passed
        ? 'Проверки пройдены'
        : 'Проверки провалены'
      : 'Автоматических проверок нет — вердикт только по ревью',
    'tester'
  )
  // Раньше падение сборки было видно только как «падает», а сам текст ошибки
  // оставался в run.checks.summary, невидимый в логе. Если правки за три
  // попытки не хватит и понадобится ручная правка — это единственное место,
  // где видно, что именно сломалось, без похода в терминал.
  if (report.ran && !report.passed) {
    log('err', report.summary.slice(-1500), 'tester')
  }

  // Поднимать неработающую сборку бессмысленно: сначала должно компилироваться.
  let runtime: RuntimeReport | null = null
  if (!report.ran || report.passed) {
    log('info', 'Запуск приложения и проверка запросами', 'tester')
    runtime = await runRuntimeCheck(projectDir, {
      scenario: askTesterForScenario,
      design: askDesigner,
      screenshotPath: screenshotPathFor(run.projectId),
      onProgress: onRuntimeProgress,
    })
    if (!run) return { report, critical: [], runtime }

    run.runtime = { ran: runtime.ran, ok: runtime.ok, summary: runtime.summary }
    run.design = runtime.layout
      ? {
          before: runtime.layout.before.findings.length,
          after: runtime.layout.after ? runtime.layout.after.findings.length : null,
        }
      : null
    if (runtime.screenshot) run.screenshot = runtime.screenshot
    if (runtime.layout) {
      const before = runtime.layout.before.findings.length
      const after = runtime.layout.after?.findings.length
      if (after === undefined) {
        log(
          before === 0 ? 'ok' : 'info',
          before === 0 ? 'Вёрстка по меркам без замечаний' : `Вёрстка: замечаний ${before}, дизайнер не правил`,
          'designer'
        )
      } else {
        log(
          after < before ? 'ok' : 'err',
          `Вёрстка: было замечаний ${before}, после правки ${after}`,
          'designer'
        )
      }
    }

    if (runtime.scenario.length > 0) {
      const passed = runtime.scenario.filter((s) => s.ok).length
      log(
        passed === runtime.scenario.length ? 'ok' : 'err',
        `Сценарий пользователя: пройдено шагов ${passed} из ${runtime.scenario.length}`,
        'tester'
      )
    }

    if (!runtime.ran) {
      log('info', 'Приложение не веб — проверять в браузере нечего', 'tester')
    } else if (runtime.ok) {
      log('ok', 'Приложение поднялось и отвечает', 'tester')
    } else {
      log('err', `Работающее приложение: замечаний ${runtime.findings.length}`, 'tester')
      for (const f of runtime.findings) {
        log(f.severity === 'hard' ? 'err' : 'info', f.text.split('\n')[0].slice(0, 200), 'tester')
      }
    }
  }

  const context = buildProjectContext({ budget: 30_000, projectId: run.projectId })
  const extra = [context, TESTER_FORMAT].filter(Boolean).join('\n\n')
  const reply = await callAgent(
    'tester',
    [
      `# Цель проекта\n${run.goal}`,
      `\n# Результат автоматических проверок\n${report.summary}`,
      runtime?.ran ? `\n# Результат запуска приложения\n${runtime.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    extra
  )
  if (reply.error) {
    log('err', `Ошибка запроса к Tester: ${reply.error}`, 'tester')
    run.review = null
    emit()
    return { report, critical: [], runtime }
  }

  const critical = extractCritical(reply.text)
  run.review = { critical, text: reply.text }
  if (critical.length > 0) {
    log('err', `Тестер нашёл критическое: ${critical.length} шт.`, 'tester')
    for (const c of critical) log('err', c, 'tester')
  } else if (reply.text) {
    log('ok', 'Ревью без критических замечаний', 'tester')
  }

  emit()
  return { report, critical, runtime }
}

/** Замечания «подними и постучись», из-за которых работу принимать нельзя. */
function runtimeBlockers(v: Verdict): string[] {
  if (!v.runtime || !v.runtime.ran || v.runtime.ok) return []
  return v.runtime.findings.filter((f) => f.severity === 'hard').map((f) => f.text)
}

/** Работа принимается, только когда прошли сборка, запуск и ревью. */
function needsFix(v: Verdict): boolean {
  return (v.report.ran && !v.report.passed) || v.critical.length > 0 || runtimeBlockers(v).length > 0
}

/** Исполнители, которые действительно что-то записали, — только им есть что чинить. */
function activeAssignees(): Assignee[] {
  if (!run) return []
  const out: Assignee[] = []
  for (const s of run.subtasks) {
    if (s.files.length > 0 && !out.includes(s.assignee)) out.push(s.assignee)
  }
  return out
}

/**
 * Кого просить чинить.
 *
 * Первый упомянутый в тексте ошибки файл — почти всегда виновник: трасса
 * начинается с места падения. Поэтому ищем не «любое совпадение», а самое
 * раннее по позиции в тексте. Если ни один файл проекта не назван, а работали
 * оба воркера, спрашиваем Admin — он видел план и знает, где чей слой.
 */
async function pickFixer(errorText: string): Promise<Assignee> {
  if (!run) return 'backend'
  const lower = errorText.toLowerCase()

  let bestAt = Infinity
  let best: Assignee | null = null
  for (const s of run.subtasks) {
    for (const f of s.files) {
      const at = indexOfMention(lower, f.toLowerCase())
      // Более поздняя подзадача, переписавшая файл, отвечает за него — поэтому
      // при равной позиции побеждает она (проход идёт по порядку плана).
      if (at !== -1 && at <= bestAt) {
        bestAt = at
        best = s.assignee
      }
    }
  }
  if (best) return best

  const active = activeAssignees()
  if (active.length === 1) return active[0]
  if (active.length === 0) return run.subtasks[0]?.assignee ?? 'backend'

  const asked = await askAdminWhoFixes(errorText)
  if (asked) {
    log('info', `Admin назначил исполнителем ${AGENT_NAME[asked]}`, 'admin')
    return asked
  }
  return run.subtasks[0]?.assignee ?? 'backend'
}

/** Арбитраж Admin: один вопрос дешевле, чем правка чужого слоя не тем воркером. */
async function askAdminWhoFixes(errorText: string): Promise<Assignee | null> {
  if (!run) return null
  const byAssignee = (a: Assignee): string => {
    const files = run!.subtasks.filter((s) => s.assignee === a).flatMap((s) => s.files)
    return files.length ? files.join(', ') : 'нет файлов'
  }

  const reply = await callAgent(
    'admin',
    [
      '# Кому чинить?',
      `Worker1 (frontend) писал: ${byAssignee('frontend')}`,
      `Worker2 (backend) писал: ${byAssignee('backend')}`,
      '',
      '# Что сломалось',
      '```',
      errorText.slice(0, 4000),
      '```',
      '',
      'Ответь ОДНИМ словом — frontend или backend. Без пояснений.',
    ].join('\n')
  )
  if (reply.error) return null

  const t = reply.text.toLowerCase()
  const f = t.indexOf('frontend')
  const b = t.indexOf('backend')
  if (f === -1 && b === -1) return null
  if (f === -1) return 'backend'
  if (b === -1) return 'frontend'
  return f < b ? 'frontend' : 'backend'
}

async function doFix(v: Verdict): Promise<boolean> {
  if (!run) return false
  setStatus('fixing')
  run.fixAttempts++

  const buildBroken = v.report.ran && !v.report.passed
  const blockers = runtimeBlockers(v)
  // Порядок объективности: не собралось → не работает → не понравилось ревью.
  // По этому же тексту выбираем исполнителя: в нём вернее всего назван виновный файл.
  const blame = buildBroken
    ? v.report.summary
    : blockers.length > 0
      ? blockers.join('\n')
      : v.critical.join('\n')
  const assignee = await pickFixer(blame)
  log('info', `Исправление, попытка ${run.fixAttempts} из ${MAX_FIX_ATTEMPTS}`, assignee)

  const context = buildProjectContext({
    keywords: blame.split(/\s+/).slice(0, 40),
    projectId: run.projectId,
  })
  const extra = [context, WORKER_FORMAT].filter(Boolean).join('\n\n')

  const task: string[] = []
  if (buildBroken) {
    task.push(
      '# Сборка проекта падает',
      'Ниже дословный вывод команд. Исправь причину и пришли изменённые файлы целиком.',
      '',
      '```',
      v.report.summary,
      '```'
    )
  }
  if (blockers.length > 0) {
    task.push(
      task.length ? '\n# Кроме того, приложение подняли и постучались в него' : '# Приложение подняли и постучались в него',
      'Так это выглядит со стороны браузера и клиента. Исправь каждое замечание и пришли изменённые файлы целиком.',
      '',
      ...blockers.map((b) => `- ${b}`)
    )
  }
  if (v.critical.length > 0) {
    task.push(
      task.length ? '\n# Кроме того, Тестер нашёл критические дефекты' : '# Тестер нашёл критические дефекты',
      'Исправь каждый и пришли изменённые файлы целиком.',
      '',
      ...v.critical.map((c) => `- ${c}`)
    )
  }

  const reply = await callAgent(assignee, task.join('\n'), extra)
  if (reply.error) {
    log('err', `Ошибка: ${reply.error}`, assignee)
    return false
  }

  const blocks = parseFileBlocks(reply.text)
  if (blocks.length === 0) {
    log('err', 'Агент не прислал исправленных файлов', assignee)
    return false
  }
  for (const b of blocks) {
    const res = writeProjectFile(b.path, b.code, run.projectId)
    log(
      res.ok ? 'ok' : 'err',
      res.ok ? `Обновлён ${b.path}` : `Не записан ${b.path}: ${res.message ?? 'ошибка'}`,
      assignee
    )
  }
  return true
}

// ---------------------------------------------------------------------------
// Управление
// ---------------------------------------------------------------------------

/**
 * Проверяется из нескольких параллельных цепочек подзадач одновременно
 * (см. runAssigneeQueue) — без проверки на терминальный статус каждая из них
 * продублировала бы и лог, и emit() в момент остановки.
 */
function shouldStop(): boolean {
  if (stopRequested) {
    if (run && !FINAL.includes(run.status)) {
      log('info', 'Остановлено пользователем')
      setStatus('stopped')
    }
    return true
  }
  if (budgetExhausted()) {
    if (run && !FINAL.includes(run.status)) {
      log('err', 'Достигнут дневной лимит расходов — конвейер остановлен')
      setStatus('failed')
    }
    return true
  }
  return false
}

export function startPipeline(goal: string): PipelineRun | null {
  const text = goal.trim()
  if (!text) return null
  // Один конвейер за раз: проверки и запись файлов идут в папке своего проекта,
  // но npm-процессы и бюджет — общие, параллелить их нечем.
  if (run && BUSY.includes(run.status)) return run

  const projectId = getActiveProjectId()
  archiveIfFinal(projectId)

  stopRequested = false
  run = {
    id: `run-${Date.now()}`,
    projectId,
    goal: text,
    status: 'analyzing',
    stack: '',
    subtasks: [],
    log: [],
    analysis: null,
    clarification: null,
    checks: null,
    runtime: null,
    design: null,
    screenshot: null,
    screenshotHistory: [],
    review: null,
    fixAttempts: 0,
    taskId: null,
    startedAt: Date.now(),
    finishedAt: null,
  }
  // Чистый лист на новый прогон — иначе кадры прошлых запусков копятся на диске.
  try {
    fs.rmSync(screenshotHistoryDir(), { recursive: true, force: true })
  } catch {
    /* не критично: максимум несколько лишних PNG на диске */
  }
  emit()

  void runAnalysisStage(text, true).catch((e: unknown) => fatal(e))

  return run
}

async function runAnalysisStage(prompt: string, allowClarify: boolean): Promise<void> {
  const outcome = await doAnalysis(prompt, allowClarify)
  if (!run) return
  if (stopRequested) return setStatus('stopped')
  if (outcome === 'failed') return setStatus('failed')
  if (outcome === 'clarify') {
    // Промежуточная остановка: без ответа пользователя оценка была бы гаданием.
    return setStatus('awaiting_clarification')
  }
  // Первая настоящая остановка конвейера: пользователь решает, делать задачу
  // вообще или нет, по оценке Analyst — до того, как Admin потратит запрос на план.
  setStatus('awaiting_analysis')
}

/** Ответ пользователя на уточняющий вопрос Analyst — второй (и последний) круг оценки. */
export function answerClarification(answer: string): void {
  const target = getRun()
  if (!target || target.status !== 'awaiting_clarification' || !target.clarification) return
  if (run && run !== target && BUSY.includes(run.status)) return

  const trimmed = answer.trim()
  if (!trimmed) return

  stopRequested = false
  const question = target.clarification.question
  run = target
  run.clarification = { question, answer: trimmed }
  log('info', 'Пользователь ответил на уточнение', 'analyst')

  const prompt = [
    run.goal,
    '',
    '# Уточнение',
    `Вопрос аналитика: ${question}`,
    `Ответ пользователя: ${trimmed}`,
  ].join('\n')
  void runAnalysisStage(prompt, false).catch((e: unknown) => fatal(e))
}

async function runPlanningStage(goal: string): Promise<void> {
  const ok = await doPlanning(goal)
  if (!run) return
  if (stopRequested) return setStatus('stopped')
  if (!ok) return setStatus('failed')
  // Вторая (и последняя) остановка конвейера: план дешевле поправить здесь,
  // чем разбирать десяток файлов, написанных не по тому плану.
  setStatus('awaiting_plan')
}

/** Согласие пользователя делать задачу — оценка Analyst принята, дальше идёт Admin. */
export function approveAnalysis(): void {
  const target = getRun()
  if (!target || target.status !== 'awaiting_analysis') return
  if (run && run !== target && BUSY.includes(run.status)) return

  stopRequested = false
  run = target
  // Если Analyst задавал вопрос, Admin должен видеть и вопрос, и ответ —
  // это часть задачи не меньше исходного текста.
  const goal = run.clarification?.answer
    ? [
        run.goal,
        '',
        '# Уточнение',
        `Вопрос аналитика: ${run.clarification.question}`,
        `Ответ пользователя: ${run.clarification.answer}`,
      ].join('\n')
    : run.goal
  void runPlanningStage(goal).catch((e: unknown) => fatal(e))
}

/** Утверждение плана пользователем — возможно с правками из интерфейса. */
export function approvePlan(edited?: PipelineSubtask[]): void {
  // Берём прогон открытого проекта, а не последний запущенный: план мог
  // пережить перезапуск приложения, и тогда переменной в памяти уже нет.
  const target = getRun()
  if (!target || target.status !== 'awaiting_plan') return
  if (run && run !== target && BUSY.includes(run.status)) return

  stopRequested = false
  run = target
  if (edited && edited.length > 0) run.subtasks = edited

  // План уходит в обычное дерево задач — панель «Задачи» показывает тот же прогресс.
  const task: TaskTree = {
    id: `task-${run.id}`,
    title: run.goal.slice(0, 80),
    description: run.stack ? `Стек: ${run.stack}` : '',
    subtasks: run.subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      assignee: s.assignee === 'frontend' ? 'Worker1' : 'Worker2',
      status: 'pending' as const,
    })),
    createdAt: new Date().toISOString(),
    autoFixEnabled: true,
  }
  addTask(task)
  run.taskId = task.id

  void runRemainder().catch((e: unknown) => fatal(e))
}

/** Неожиданное исключение внутри конвейера: без этого оно стало бы «тихим» зависанием. */
function fatal(e: unknown): void {
  if (!run) return
  log('err', `Сбой конвейера: ${e instanceof Error ? e.message : String(e)}`)
  setStatus('failed')
}

/**
 * Снимок состояния проекта после шага.
 *
 * Молча пропускаем, если git не установлен: снимки — страховка на случай, когда
 * воркер испортит уже написанный файл, а не условие работы конвейера.
 */
async function takeSnapshot(message: string): Promise<void> {
  if (!run) return
  const res = await snapshot(message, run.projectId)
  if (res.ok && res.commit) log('ok', `Снимок ${res.commit}: ${message}`)
  else if (!res.ok && res.message !== 'git не найден' && res.message !== 'нет репозитория') {
    log('info', `Снимок не сделан: ${res.message ?? 'причина неизвестна'}`)
  }
}

/**
 * Очередь поверх takeSnapshot: подзадачи разных исполнителей пишут файлы
 * параллельно (см. runAssigneeQueue), а `git commit` параллельным не бывает —
 * два одновременных снимка гонялись бы за одним и тем же index.lock. Каждый
 * вызов встаёт в хвост, выполняется, только когда предыдущий закончился.
 */
let snapshotQueue: Promise<void> = Promise.resolve()
function queueSnapshot(message: string): Promise<void> {
  const next = snapshotQueue.then(() => takeSnapshot(message)).catch(() => undefined)
  snapshotQueue = next
  return next
}

/**
 * Подзадачи одного исполнителя выполняются по порядку плана (внутри своей
 * зоны ответственности порядок может быть важен — например, сперва схема БД,
 * потом эндпоинт). А вот Worker1 и Worker2 друг от друга обычно не зависят —
 * Admin и так делит между ними фронт и бэк, — поэтому их очереди подзадач
 * идут параллельно, а не одна за другой.
 */
async function runAssigneeQueue(assignee: Assignee): Promise<void> {
  if (!run) return
  for (const sub of run.subtasks) {
    if (sub.assignee !== assignee) continue
    if (shouldStop()) return
    if (sub.status === 'done') continue
    const ok = await doSubtask(sub)
    if (ok) await queueSnapshot(`feat: ${sub.title}`)
  }
}

async function runRemainder(): Promise<void> {
  if (!run) return
  setStatus('working')

  const written = applyScaffold(run.projectId, run.stack ?? '', run.subtasks)
  if (written.length > 0) {
    log('info', `Базовый каркас применён: ${written.length} файлов`)
  }

  const repo = await ensureRepo(run.projectId)
  if (repo.ok && repo.created) {
    log('info', 'Папка проекта под git: после каждого шага делается снимок')
    await queueSnapshot('chore: состояние до запуска конвейера')
  } else if (!repo.ok) {
    log('info', `Снимки истории недоступны: ${repo.message ?? 'git не найден'}`)
  }

  await Promise.all([runAssigneeQueue('frontend'), runAssigneeQueue('backend')])

  if (shouldStop()) return

  let verdict = await doVerify()
  while (needsFix(verdict) && run && run.fixAttempts < MAX_FIX_ATTEMPTS) {
    if (shouldStop()) return
    const fixed = await doFix(verdict)
    if (fixed) await queueSnapshot(`fix: правка ${run?.fixAttempts ?? 0}`)
    if (!fixed) break
    if (shouldStop()) return
    verdict = await doVerify()
  }

  if (!run) return
  const anyWork = run.subtasks.some((s) => s.status === 'done')
  if (!anyWork) {
    log('err', 'Ни одна подзадача не выполнена')
    return setStatus('failed')
  }
  // Установка зависимостей и сборка создают файлы, которых не было на момент
  // последнего снимка (package-lock.json и подобные). Без этого проект уезжает
  // к пользователю с незакоммиченными изменениями прямо из коробки.
  await queueSnapshot('chore: состояние после проверок')
  if (verdict.report.ran && !verdict.report.passed) {
    log('err', 'Сборка так и не проходит — нужна ручная правка')
    return setStatus('failed')
  }
  if (runtimeBlockers(verdict).length > 0) {
    log('err', 'Приложение собирается, но работает неправильно — нужна ручная правка')
    return setStatus('failed')
  }
  if (verdict.critical.length > 0) {
    log('err', 'Тестер настаивает на критических замечаниях — нужна ручная правка')
    return setStatus('failed')
  }
  // Проверять было нечем: ни package.json, ни requirements.txt. Код написан,
  // но никто его не запускал — выдавать это за успех нельзя.
  if (!verdict.report.ran) {
    log('err', 'Код написан, но проверить его нечем: в проекте нет ни сборки, ни тестов')
    return setStatus('unverified')
  }
  log('ok', 'Готово')
  setStatus('done')
}

/**
 * Выход из приложения: обрываем запрос к провайдеру и на этом всё.
 *
 * Состояние на диске намеренно не трогаем: прогон, ждущий утверждения плана,
 * должен пережить перезапуск, а незавершённый пометится прерванным при
 * следующем старте — там для этого есть вся картина.
 */
export function shutdownPipeline(): void {
  stopRequested = true
  abort?.abort()
  // Проверка могла держать поднятый сервер проекта: он переживёт закрытие
  // приложения и останется занимать порт, если его не убить явно.
  stopRuntimeCheck()
}

/** Остановка по кнопке пользователя — в отличие от выхода, закрывает и гейт. */
export function stopPipeline(): void {
  shutdownPipeline()

  // На гейте цикл не крутится, флаг заметить некому — закрываем прогон сами,
  // иначе окно гейта нечем отменить и оно возвращается после перезапуска.
  const target = getRun()
  if (target && GATES.includes(target.status)) {
    run = target
    const message =
      target.status === 'awaiting_clarification'
        ? 'Уточнение отклонено, конвейер остановлен'
        : target.status === 'awaiting_analysis'
          ? 'Задача отклонена после анализа'
          : 'План отклонён'
    log('info', message)
    setStatus('stopped')
  }
}

export function registerPipelineIPC(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  // Разбор прерванных прогонов делаем на старте, а не при первом обращении
  // из интерфейса: иначе «выполняется» успеет мелькнуть в панели.
  loadRuns()
  // Возвращаем прогон открытого проекта, а не тот, что вернул startPipeline:
  // при отказе (занят другой проект) интерфейс не должен показывать чужую работу.
  ipcMain.handle('pipeline:start', (_e: IpcMainInvokeEvent, goal: string) => {
    startPipeline(goal)
    return getRun()
  })
  ipcMain.handle('pipeline:get', () => getRun())
  ipcMain.handle('pipeline:getHistory', () => getRunHistory())
  ipcMain.handle('pipeline:answerClarification', (_e: IpcMainInvokeEvent, answer: string) =>
    answerClarification(answer)
  )
  ipcMain.handle('pipeline:approveAnalysis', () => approveAnalysis())
  ipcMain.handle('pipeline:approve', (_e: IpcMainInvokeEvent, edited?: PipelineSubtask[]) =>
    approvePlan(edited)
  )
  ipcMain.handle('pipeline:stop', () => stopPipeline())
}
