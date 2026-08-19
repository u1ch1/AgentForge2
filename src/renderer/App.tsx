import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import TitleBar, { type MenuDef } from './components/TitleBar'
import ProjectTabs from './components/ProjectTabs'
import OptionsBar from './components/OptionsBar'
import StatusBar from './components/StatusBar'
import ToolRail, { type RailItem } from './components/ToolRail'
import PanelChrome from './components/PanelChrome'
import ChatPanel from './components/ChatPanel'
import PipelinePanel from './components/PipelinePanel'
import PlanApproval from './components/PlanApproval'
import AnalysisApproval from './components/AnalysisApproval'
import ClarificationPrompt from './components/ClarificationPrompt'
import EconomyAlert from './components/EconomyAlert'
import AgentsPanel from './components/AgentsPanel'
import TasksPanel from './components/TasksPanel'
import TemplatesPanel from './components/TemplatesPanel'
import AutoFixPanel from './components/AutoFixPanel'
import FileManagerPanel from './components/FileManagerPanel'
import TokenTrackerPanel from './components/TokenTrackerPanel'
import FilesPanel from './components/FilesPanel'
import LivePreview from './components/LivePreview'
import ProjectMemoryPanel from './components/ProjectMemoryPanel'
import DeployPanel from './components/DeployPanel'
import SettingsPanel from './components/SettingsPanel'
import {
  Modal,
  NewTaskForm,
  NewProjectForm,
  ConfirmDialog,
  AboutBox,
  HistoryBrowser,
} from './components/Dialogs'
import type {
  Agent,
  AllModels,
  AppSettings,
  ChatSummary,
  KeyStatus,
  Message,
  PipelineRun,
  PipelineSubtask,
  Project,
  TaskTree,
  TemplateInfo,
  UsageInfo,
} from './types'
import { providerForModel, isCodeOnlyAgent } from './types'
import { ps, metrics, fonts } from './theme'
import { Icon } from './icons'
import { playChime } from './sound'
import { parseFileBlocks } from '../shared/code-blocks'

/** Worker1/Worker2: сохраняет каждый помеченный путём блок кода как файл проекта. */
async function saveWorkerCodeBlocks(
  text: string,
  notify: (kind: 'ok' | 'err', text: string) => void
): Promise<void> {
  const blocks = parseFileBlocks(text)
  if (blocks.length === 0) return
  const saved: string[] = []
  const failed: string[] = []
  for (const b of blocks) {
    const res = await window.electronAPI.writeProjectFile(b.path, b.code)
    if (res.ok) saved.push(b.path)
    else failed.push(`${b.path}${res.message ? ' — ' + res.message : ''}`)
  }
  if (saved.length) notify('ok', `Сохранено в проект: ${saved.join(', ')}`)
  if (failed.length) notify('err', `Не удалось сохранить: ${failed.join('; ')}`)
}

type Tool = 'pipeline' | 'agents' | 'tasks' | 'templates' | 'fixes'
type Panel = 'files' | 'prompts' | 'tokens' | 'preview' | 'memory' | 'deploy' | 'settings'
type Dialog = 'none' | 'history' | 'newTask' | 'newProject' | 'about' | 'closeProject' | 'clearChat'

/** Стадии, где конвейер реально гоняет npm-процессы — второй ручной прогон поверх них лишний. */
const PIPELINE_BUSY_STATUSES: PipelineRun['status'][] = ['analyzing', 'planning', 'working', 'verifying', 'fixing']

const TOOLS: RailItem<Tool>[] = [
  { id: 'pipeline', icon: 'play', title: 'Конвейер', badge: 'K' },
  { id: 'agents', icon: 'move', title: 'Агенты', badge: 'A' },
  { id: 'tasks', icon: 'tree', title: 'Задачи', badge: 'T' },
  { id: 'templates', icon: 'shapes', title: 'Шаблоны', badge: 'S' },
  { id: 'fixes', icon: 'bandage', title: 'Auto-Fix', badge: 'F' },
]

const PANELS: RailItem<Panel>[] = [
  { id: 'files', icon: 'folder', title: 'Файлы проекта' },
  { id: 'prompts', icon: 'doc', title: 'Промпты агентов' },
  { id: 'tokens', icon: 'chart', title: 'Токены' },
  { id: 'preview', icon: 'eye', title: 'Просмотр' },
  { id: 'memory', icon: 'chip', title: 'Память проекта' },
  { id: 'deploy', icon: 'deploy', title: 'Деплой' },
  { id: 'settings', icon: 'sliders', title: 'Настройки' },
]

const TOOL_TITLES: Record<Tool, string> = {
  pipeline: 'Конвейер',
  agents: 'Агенты',
  tasks: 'Задачи',
  templates: 'Шаблоны',
  fixes: 'Auto-Fix',
}

export default function App() {
  // --- Проекты ---
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({})
  const [projectDir, setProjectDir] = useState('')

  // --- Данные активного проекта ---
  const [agents, setAgents] = useState<Agent[]>([])
  const [activeAgentId, setActiveAgentId] = useState('admin')
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  const [chatSummary, setChatSummary] = useState<ChatSummary[]>([])
  const [tasks, setTasks] = useState<TaskTree[]>([])
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [models, setModels] = useState<AllModels>({ claude: { models: [] }, kimi: { models: [] } })

  // --- Чат ---
  const [inputValue, setInputValue] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // --- Конфигурация ---
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({
    claude: false,
    kimi: false,
    persistent: false,
  })
  const [usage, setUsage] = useState<UsageInfo>({ daily: 0, budget: 10, economyMode: false })
  const [settings, setSettings] = useState<AppSettings>({
    dailyBudget: 10,
    kimiBaseUrl: 'https://api.moonshot.ai/v1',
    chatFontSize: 'medium',
    chatWidth: 'comfortable',
    chatShowTimestamps: true,
    chatShowModelBadge: true,
    chatSound: false,
  })
  const [workspace, setWorkspace] = useState('')
  const [showEconomyAlert, setShowEconomyAlert] = useState(false)

  // --- Конвейер ---
  const [pipeline, setPipeline] = useState<PipelineRun | null>(null)

  // --- Интерфейс ---
  const [tool, setTool] = useState<Tool>('pipeline')
  const [panel, setPanel] = useState<Panel>('files')
  const [dialog, setDialog] = useState<Dialog>('none')
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const [showLeft, setShowLeft] = useState(true)
  const [showRight, setShowRight] = useState(true)
  const [showOptions, setShowOptions] = useState(true)
  const [showStatus, setShowStatus] = useState(true)

  const requestIdRef = useRef<string | null>(null)
  const pendingAgentRef = useRef('admin')
  const pendingProjectRef = useRef('')
  const streamingRef = useRef('')
  const chatSoundRef = useRef(false)

  useEffect(() => {
    chatSoundRef.current = settings.chatSound
  }, [settings.chatSound])

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 4500)
  }, [])

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const projectName = activeProject?.name ?? '—'

  // --- Загрузка данных проекта ---
  const loadProjectData = useCallback(async () => {
    const api = window.electronAPI
    const [chats, taskList, summary, counts, dirInfo, run] = await Promise.all([
      api.getProjectChats(),
      api.getTasks(),
      api.getChatSummary(),
      api.getChatCounts(),
      api.getProjectDir(),
      // Прогон конвейера хранится по проекту: при переключении показываем тот,
      // что относится к открытому проекту, а не последний запущенный.
      api.pipelineGet(),
    ])
    setMessages(chats as Record<string, Message[]>)
    setTasks(taskList)
    setChatSummary(summary)
    setProjectCounts(counts)
    setProjectDir(dirInfo.dir)
    setPipeline(run)
  }, [])

  const reloadUsage = useCallback(async () => setUsage(await window.electronAPI.getUsage()), [])
  const reloadTasks = useCallback(async () => setTasks(await window.electronAPI.getTasks()), [])

  const reloadModels = useCallback(
    async (force = false) => {
      const res = await window.electronAPI.listModels(force)
      setModels(res)
      if (force) {
        const parts: string[] = []
        if (res.claude.error) parts.push(`Anthropic: ${res.claude.error}`)
        if (res.kimi.error) parts.push(`Moonshot: ${res.kimi.error}`)
        notify(
          parts.length ? 'err' : 'ok',
          parts.length
            ? parts.join(' · ')
            : `Список обновлён: Anthropic ${res.claude.models.length}, Moonshot ${res.kimi.models.length}`
        )
      }
    },
    [notify]
  )

  useEffect(() => {
    const init = async () => {
      const api = window.electronAPI
      const list = await api.listProjects()
      setProjects(list.projects)
      setActiveProjectId(list.activeId)

      setAgents(await api.getAgents())
      setKeyStatus(await api.getKeyStatus())
      setUsage(await api.getUsage())
      setSettings(await api.getSettings())
      setTemplates(await api.listTemplates())
      setWorkspace((await api.getWorkspace()).workspace)
      setModels(await api.listModels(false))
      await loadProjectData()
    }
    void init()
  }, [loadProjectData])

  // --- Переключение проекта ---
  const switchProject = useCallback(
    async (id: string) => {
      if (id === activeProjectId || isStreaming) {
        if (isStreaming) notify('err', 'Дождитесь окончания генерации или нажмите «Стоп»')
        return
      }
      await window.electronAPI.setActiveProject(id)
      setActiveProjectId(id)
      setError(null)
      setInputValue('')
      await loadProjectData()
    },
    [activeProjectId, isStreaming, loadProjectData, notify]
  )

  // --- Стрим ---
  useEffect(() => {
    return window.electronAPI.onStreamChunk((reqId, chunk) => {
      if (reqId !== requestIdRef.current) return
      const agentId = pendingAgentRef.current
      const projectId = pendingProjectRef.current

      if (chunk.type === 'chunk') {
        streamingRef.current += chunk.text
        setStreamingText(streamingRef.current)
        return
      }

      const finish = (extra?: Partial<Message>): string => {
        const text = streamingRef.current.trim()
        if (text) {
          const msg: Message = {
            id: `a-${Date.now()}`,
            sender: 'agent',
            text,
            timestamp: Date.now(),
            ...extra,
          }
          // Сообщение принадлежит тому проекту, в котором был отправлен запрос:
          // на экране может быть уже другой, если пользователь переключился.
          void window.electronAPI.appendMessage(agentId, msg)
          if (projectId === activeProjectId) {
            setMessages((prev) => ({ ...prev, [agentId]: [...(prev[agentId] || []), msg] }))
          }
          void window.electronAPI.getChatCounts().then(setProjectCounts)
        }
        streamingRef.current = ''
        setStreamingText('')
        setIsStreaming(false)
        requestIdRef.current = null
        return text
      }

      if (chunk.type === 'error') {
        finish()
        setError(chunk.message)
        return
      }

      const finalText = finish({ provider: chunk.provider, model: chunk.model })
      if (chatSoundRef.current) playChime()
      if (isCodeOnlyAgent(agentId)) void saveWorkerCodeBlocks(finalText, notify)
      void reloadUsage()
      void window.electronAPI.getChatSummary().then(setChatSummary)
      if (chunk.usage.budgetTriggered) setShowEconomyAlert(true)
    })
  }, [reloadUsage, activeProjectId, notify])

  const activeAgent = agents.find((a) => a.id === activeAgentId) || agents[0]
  const activeProvider = activeAgent ? providerForModel(activeAgent.model) : 'kimi'
  const providerModels = models[activeProvider].models
  const allModels = useMemo(
    () => [...models.claude.models, ...models.kimi.models],
    [models.claude.models, models.kimi.models]
  )
  const hasKeyForActive = activeProvider === 'claude' ? keyStatus.claude : keyStatus.kimi

  // --- Действия ---

  /** Общий пусковой механизм генерации — используется первой отправкой,
   *  повтором ответа и продолжением после редактирования сообщения. */
  const runStream = useCallback(
    (history: Message[]) => {
      streamingRef.current = ''
      setStreamingText('')
      setIsStreaming(true)

      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      requestIdRef.current = reqId
      pendingAgentRef.current = activeAgentId
      pendingProjectRef.current = activeProjectId
      window.electronAPI.streamChat(
        reqId,
        activeAgentId,
        history.map((m) => ({
          role: m.sender === 'user' ? ('user' as const) : ('assistant' as const),
          content: m.text,
        }))
      )
    },
    [activeAgentId, activeProjectId]
  )

  const handleSend = useCallback(() => {
    const text = inputValue.trim()
    if (!text || isStreaming || !activeAgent) return

    const needed = providerForModel(activeAgent.model)
    if ((needed === 'claude' && !keyStatus.claude) || (needed === 'kimi' && !keyStatus.kimi)) {
      setError(
        `Для модели ${activeAgent.model} нужен ключ ${needed === 'claude' ? 'Anthropic' : 'Moonshot'}. Откройте панель «Настройки».`
      )
      setPanel('settings')
      setShowRight(true)
      return
    }

    setError(null)
    const userMsg: Message = { id: `u-${Date.now()}`, sender: 'user', text, timestamp: Date.now() }
    const history = [...(messages[activeAgentId] || []), userMsg]

    setMessages((prev) => ({ ...prev, [activeAgentId]: history }))
    void window.electronAPI.appendMessage(activeAgentId, userMsg)
    setInputValue('')
    runStream(history)
  }, [inputValue, isStreaming, activeAgent, activeAgentId, messages, keyStatus, runStream])

  const handleStop = useCallback(() => {
    if (requestIdRef.current) void window.electronAPI.abortChat(requestIdRef.current)
  }, [])

  /** Повтор последнего ответа агента: отбрасываем его и просим модель снова. */
  const handleRegenerate = useCallback(() => {
    if (isStreaming || !activeAgent) return
    const current = messages[activeAgentId] || []
    if (current.length === 0) return
    const last = current[current.length - 1]
    const history = last.sender === 'agent' ? current.slice(0, -1) : current
    if (history.length === 0 || history[history.length - 1].sender !== 'user') return

    void window.electronAPI.setChatMessages(activeAgentId, history)
    setMessages((prev) => ({ ...prev, [activeAgentId]: history }))
    setError(null)
    runStream(history)
  }, [isStreaming, activeAgent, messages, activeAgentId, runStream])

  /** Правка своего сообщения: всё, что было после него, теряет силу, ответ генерируется заново. */
  const handleEditMessage = useCallback(
    (messageId: string, newText: string) => {
      if (isStreaming) return
      const current = messages[activeAgentId] || []
      const idx = current.findIndex((m) => m.id === messageId)
      if (idx === -1) return
      const edited: Message = { ...current[idx], text: newText }
      const history = [...current.slice(0, idx), edited]

      void window.electronAPI.setChatMessages(activeAgentId, history)
      setMessages((prev) => ({ ...prev, [activeAgentId]: history }))
      setError(null)
      void window.electronAPI.getChatCounts().then(setProjectCounts)
      void window.electronAPI.getChatSummary().then(setChatSummary)
      runStream(history)
    },
    [isStreaming, messages, activeAgentId, runStream]
  )

  /** Удаление одного сообщения — без пересчёта ответа, только чистка истории. */
  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      if (isStreaming) return
      const current = messages[activeAgentId] || []
      const next = current.filter((m) => m.id !== messageId)
      if (next.length === current.length) return
      void window.electronAPI.setChatMessages(activeAgentId, next)
      setMessages((prev) => ({ ...prev, [activeAgentId]: next }))
      void window.electronAPI.getChatCounts().then(setProjectCounts)
      void window.electronAPI.getChatSummary().then(setChatSummary)
    },
    [isStreaming, messages, activeAgentId]
  )

  const handleSetAgentModel = useCallback(async (agentId: string, model: string) => {
    await window.electronAPI.setAgentModel(agentId, model)
    setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, model } : a)))
  }, [])

  const handleSaveKey = useCallback(
    async (provider: 'claude' | 'kimi', key: string) => {
      await window.electronAPI.setProvider({ provider, apiKey: key })
      setKeyStatus(await window.electronAPI.getKeyStatus())
      await reloadModels(false)
      notify('ok', `Ключ ${provider === 'claude' ? 'Anthropic' : 'Moonshot'} сохранён`)
    },
    [notify, reloadModels]
  )

  const handleUpdateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      setSettings(await window.electronAPI.updateSettings(patch))
      await reloadUsage()
      if (patch.kimiBaseUrl) await reloadModels(false)
    },
    [reloadUsage, reloadModels]
  )

  const handleResetEconomy = useCallback(async () => {
    await window.electronAPI.resetEconomy()
    await reloadUsage()
    setShowEconomyAlert(false)
    notify('ok', 'Счётчик расходов обнулён')
  }, [notify, reloadUsage])

  const handleExport = useCallback(async () => {
    const res = await window.electronAPI.exportProject()
    if (res.status === 'ok') notify('ok', `Экспортировано: ${res.path}`)
    else if (res.status !== 'cancelled') notify('err', res.message || 'Ошибка экспорта')
  }, [notify])

  const handleCreateTemplate = useCallback(
    async (type: string) => {
      const res = await window.electronAPI.createTemplate(type)
      if (res.success) {
        notify('ok', `Шаблон создан в проекте «${projectName}». Выполните npm install.`)
        setPanel('files')
        setShowRight(true)
      }
    },
    [notify, projectName]
  )

  const handleAddTask = useCallback(
    async (title: string, description: string) => {
      await window.electronAPI.addTask({
        id: `t-${Date.now()}`,
        title,
        description,
        subtasks: [],
        createdAt: new Date().toISOString(),
        autoFixEnabled: false,
      })
      await reloadTasks()
      setDialog('none')
      setTool('tasks')
      setShowLeft(true)
    },
    [reloadTasks]
  )

  const handleCreateProject = useCallback(
    async (name: string) => {
      const project = await window.electronAPI.createProject(name)
      const list = await window.electronAPI.listProjects()
      setProjects(list.projects)
      setActiveProjectId(project.id)
      setDialog('none')
      await loadProjectData()
      notify('ok', `Проект «${project.name}» создан: папка projects/${project.slug}`)
    },
    [loadProjectData, notify]
  )

  const handleCloseProject = useCallback(async () => {
    if (!pendingCloseId) return
    const res = await window.electronAPI.deleteProject(pendingCloseId)
    setDialog('none')
    setPendingCloseId(null)
    if (!res.ok) return notify('err', res.reason ?? 'Не удалось убрать проект')

    const list = await window.electronAPI.listProjects()
    setProjects(list.projects)
    setActiveProjectId(list.activeId)
    await loadProjectData()
    notify('ok', 'Проект убран из списка. Файлы остались на диске.')
  }, [pendingCloseId, loadProjectData, notify])

  const handleClearChat = useCallback(async () => {
    await window.electronAPI.clearChat(activeAgentId)
    setMessages((prev) => ({ ...prev, [activeAgentId]: [] }))
    setProjectCounts(await window.electronAPI.getChatCounts())
    setChatSummary(await window.electronAPI.getChatSummary())
    setError(null)
    setDialog('none')
  }, [activeAgentId])

  const agentNames = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.id, a.name])),
    [agents]
  )

  // --- Конвейер ---
  useEffect(() => {
    void window.electronAPI.pipelineGet().then(setPipeline)
    return window.electronAPI.onPipelineUpdate(setPipeline)
  }, [])

  // Сколько файлов записал конвейер: панель файлов обновляется по этому числу,
  // иначе показывала бы папку такой, какой она была до запуска.
  const pipelineWrites = useMemo(
    () =>
      pipeline
        ? pipeline.subtasks.reduce((n, s) => n + s.files.length, 0) + pipeline.fixAttempts
        : 0,
    [pipeline]
  )

  // Конвейер пишет в чаты агентов, файлы и дерево задач прямо из main-процесса.
  // Панели об этом не знают, поэтому перечитываем данные при смене этапа.
  const pipelineStageRef = useRef('')
  useEffect(() => {
    if (!pipeline) return
    const doneCount = pipeline.subtasks.filter((s) => s.status === 'done').length
    const stage = `${pipeline.status}:${doneCount}:${pipeline.fixAttempts}`
    if (stage === pipelineStageRef.current) return
    pipelineStageRef.current = stage
    void loadProjectData()
  }, [pipeline, loadProjectData])

  const handlePipelineStart = useCallback(
    async (goal: string) => {
      if (!keyStatus.claude && !keyStatus.kimi) {
        notify('err', 'Сначала задайте API-ключ — конвейер работает через провайдера')
        setPanel('settings')
        setShowRight(true)
        return
      }
      const started = await window.electronAPI.pipelineStart(goal)
      setPipeline(started)
      // Конвейер один на всё приложение: он гоняет npm-процессы и тратит общий
      // бюджет. Отказ виден только по тому, что задача не стала прогоном.
      if (!started || started.goal !== goal) {
        notify('err', 'Конвейер уже занят другим проектом — дождитесь его или остановите')
      }
    },
    [keyStatus, notify]
  )

  const handlePipelineAnswerClarification = useCallback(async (answer: string) => {
    await window.electronAPI.pipelineAnswerClarification(answer)
  }, [])

  const handlePipelineApproveAnalysis = useCallback(async () => {
    await window.electronAPI.pipelineApproveAnalysis()
  }, [])

  const handlePipelineApprove = useCallback(async (subtasks: PipelineSubtask[]) => {
    await window.electronAPI.pipelineApprove(subtasks)
  }, [])

  const handlePipelineStop = useCallback(async () => {
    await window.electronAPI.pipelineStop()
  }, [])

  // --- Меню ---
  const menus: MenuDef[] = useMemo(
    () => [
      {
        label: 'Файл',
        items: [
          { label: 'Новый проект…', shortcut: 'Ctrl+Shift+N', onSelect: () => setDialog('newProject') },
          { label: 'Новая задача…', shortcut: 'Ctrl+N', onSelect: () => setDialog('newTask') },
          {
            label: 'Создать из шаблона',
            submenu: templates.map((t) => ({
              label: t.name,
              onSelect: () => void handleCreateTemplate(t.id),
            })),
          },
          {},
          { label: 'Экспортировать проект…', onSelect: () => void handleExport() },
          { label: 'Открыть папку проекта', onSelect: () => void window.electronAPI.filesReveal() },
          {
            label: 'Открыть рабочую папку',
            onSelect: () => void window.electronAPI.revealWorkspaceRoot(),
          },
          {},
          { label: 'Выход', onSelect: () => void window.electronAPI.windowClose() },
        ],
      },
      {
        label: 'Правка',
        items: [
          { label: 'Очистить текущий диалог', onSelect: () => setDialog('clearChat') },
          { label: 'Поиск по диалогам…', shortcut: 'Ctrl+F', onSelect: () => setDialog('history') },
          {},
          { label: 'Сбросить счётчик расходов', onSelect: () => void handleResetEconomy() },
          {
            label: 'Настройки',
            onSelect: () => {
              setPanel('settings')
              setShowRight(true)
            },
          },
        ],
      },
      {
        label: 'Проект',
        items: [
          ...projects.map((p) => ({
            label: p.name,
            checked: p.id === activeProjectId,
            onSelect: () => void switchProject(p.id),
          })),
          {},
          { label: 'Создать проект…', onSelect: () => setDialog('newProject') },
          {
            label: 'Убрать текущий из списка',
            disabled: projects.length <= 1,
            onSelect: () => {
              setPendingCloseId(activeProjectId)
              setDialog('closeProject')
            },
          },
          {},
          {
            label: 'Память проекта',
            onSelect: () => {
              setPanel('memory')
              setShowRight(true)
            },
          },
          {
            label: 'Подготовить деплой',
            onSelect: () => {
              setPanel('deploy')
              setShowRight(true)
            },
          },
        ],
      },
      {
        label: 'Агент',
        items: [
          ...agents.map((a) => ({
            label: `${a.name} — ${a.role}`,
            checked: a.id === activeAgentId,
            onSelect: () => setActiveAgentId(a.id),
          })),
          {},
          { label: 'Прервать генерацию', disabled: !isStreaming, onSelect: handleStop },
          { label: 'Обновить список моделей', onSelect: () => void reloadModels(true) },
        ],
      },
      {
        label: 'Вид',
        items: [
          {
            label: 'Панель параметров',
            checked: showOptions,
            onSelect: () => setShowOptions((v) => !v),
          },
          { label: 'Левая панель', checked: showLeft, onSelect: () => setShowLeft((v) => !v) },
          { label: 'Правая панель', checked: showRight, onSelect: () => setShowRight((v) => !v) },
          {
            label: 'Строка состояния',
            checked: showStatus,
            onSelect: () => setShowStatus((v) => !v),
          },
        ],
      },
      { label: 'Справка', items: [{ label: 'О программе', onSelect: () => setDialog('about') }] },
    ],
    [
      templates,
      agents,
      projects,
      activeProjectId,
      activeAgentId,
      isStreaming,
      showOptions,
      showLeft,
      showRight,
      showStatus,
      handleCreateTemplate,
      handleExport,
      handleResetEconomy,
      handleStop,
      reloadModels,
      switchProject,
    ]
  )

  // Панели перечитывают данные при смене проекта — принудительный ремонт по ключу.
  const projectKey = activeProjectId

  const leftBody = () => {
    if (tool === 'pipeline') {
      return (
        <PipelinePanel
          run={pipeline}
          projectName={projectName}
          onStart={(goal) => void handlePipelineStart(goal)}
          onStop={() => void handlePipelineStop()}
        />
      )
    }
    if (tool === 'agents') {
      return (
        <AgentsPanel
          agents={agents}
          activeId={activeAgentId}
          keyStatus={keyStatus}
          summary={chatSummary}
          onSelect={setActiveAgentId}
        />
      )
    }
    if (tool === 'tasks') {
      return (
        <TasksPanel
          tasks={tasks}
          agents={agents}
          onCreateTask={() => setDialog('newTask')}
          onReload={reloadTasks}
        />
      )
    }
    if (tool === 'templates') {
      return <TemplatesPanel templates={templates} onCreate={handleCreateTemplate} />
    }
    return <AutoFixPanel />
  }

  const rightBody = () => {
    switch (panel) {
      case 'files':
        return <FilesPanel projectName={projectName} externalWrites={pipelineWrites} />
      case 'prompts':
        return <FileManagerPanel />
      case 'tokens':
        return <TokenTrackerPanel />
      case 'preview':
        return <LivePreview pipelineBusy={Boolean(pipeline && PIPELINE_BUSY_STATUSES.includes(pipeline.status))} />
      case 'memory':
        return <ProjectMemoryPanel />
      case 'deploy':
        return <DeployPanel />
      case 'settings':
        return (
          <SettingsPanel
            agents={agents}
            keyStatus={keyStatus}
            usage={usage}
            settings={settings}
            workspace={workspace}
            models={models}
            onSaveKey={handleSaveKey}
            onSetAgentModel={handleSetAgentModel}
            onUpdateSettings={handleUpdateSettings}
            onChooseWorkspace={async () => {
              const res = await window.electronAPI.chooseWorkspace()
              if (res.changed && res.workspace) {
                setWorkspace(res.workspace)
                await loadProjectData()
                notify('ok', 'Рабочая папка изменена')
              }
            }}
            onResetEconomy={handleResetEconomy}
            onRefreshModels={() => reloadModels(true)}
            onTestKey={async (provider) => window.electronAPI.testKey(provider)}
          />
        )
    }
  }

  const panelDef = PANELS.find((p) => p.id === panel)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        background: ps.appBg,
        color: ps.text,
        fontFamily: fonts.ui,
        fontSize: '11px',
        overflow: 'hidden',
      }}
    >
      <TitleBar menus={menus} title={projectName} />

      <ProjectTabs
        projects={projects}
        activeId={activeProjectId}
        counts={projectCounts}
        onSelect={(id) => void switchProject(id)}
        onCreate={() => setDialog('newProject')}
        onRename={async (id, name) => {
          await window.electronAPI.renameProject(id, name)
          setProjects((await window.electronAPI.listProjects()).projects)
        }}
        onClose={(id) => {
          setPendingCloseId(id)
          setDialog('closeProject')
        }}
      />

      {showOptions && (
        <OptionsBar
          agent={activeAgent}
          models={providerModels}
          hasKey={hasKeyForActive}
          isStreaming={isStreaming}
          usage={usage}
          onModelChange={(m) => activeAgent && void handleSetAgentModel(activeAgent.id, m)}
          onStop={handleStop}
        />
      )}

      {toast && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '5px 10px',
            background: ps.panel,
            borderBottom: `1px solid ${ps.borderDark}`,
            borderLeft: `3px solid ${toast.kind === 'ok' ? ps.ok : ps.err}`,
            color: toast.kind === 'ok' ? ps.text : ps.err,
            fontSize: '11px',
            flexShrink: 0,
          }}
        >
          <Icon name={toast.kind === 'ok' ? 'check' : 'alert'} size={13} />
          <span style={{ flex: 1 }}>{toast.text}</span>
          <button
            onClick={() => setToast(null)}
            style={{
              background: 'none',
              border: 'none',
              color: ps.textDim,
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
            }}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <ToolRail items={TOOLS} active={tool} onSelect={setTool} side="left" />

        {showLeft && (
          <div
            style={{
              width: metrics.leftPanelW,
              flexShrink: 0,
              borderRight: `1px solid ${ps.borderDark}`,
            }}
          >
            <PanelChrome
              title={TOOL_TITLES[tool]}
              icon={TOOLS.find((t) => t.id === tool)?.icon}
              actions={
                tool === 'tasks'
                  ? [{ icon: 'plus', title: 'Новая задача', onClick: () => setDialog('newTask') }]
                  : undefined
              }
            >
              <div key={projectKey} style={{ height: '100%' }}>
                {leftBody()}
              </div>
            </PanelChrome>
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', background: ps.canvas }}>
          <ChatPanel
            agent={activeAgent}
            projectName={projectName}
            messages={messages[activeAgentId] || []}
            streamingText={streamingText}
            isStreaming={isStreaming}
            inputValue={inputValue}
            onInputChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            error={error}
            onDismissError={() => setError(null)}
            settings={settings}
            onUpdateSettings={handleUpdateSettings}
            onEditMessage={handleEditMessage}
            onRegenerate={handleRegenerate}
            onDeleteMessage={handleDeleteMessage}
            onClearChat={() => setDialog('clearChat')}
          />
        </div>

        {showRight && (
          <div
            style={{
              width: metrics.rightPanelW,
              flexShrink: 0,
              borderLeft: `1px solid ${ps.borderDark}`,
            }}
          >
            <PanelChrome title={panelDef?.title ?? ''} icon={panelDef?.icon}>
              <div key={projectKey} style={{ height: '100%' }}>
                {rightBody()}
              </div>
            </PanelChrome>
          </div>
        )}

        <ToolRail items={PANELS} active={panel} onSelect={setPanel} side="right" />
      </div>

      {showStatus && (
        <StatusBar
          state={isStreaming ? 'Генерация…' : 'Готово'}
          project={projectName}
          model={activeAgent?.model ?? ''}
          messageCount={Object.values(messages).flat().length}
          spent={usage.daily}
          budget={usage.budget}
          economyMode={usage.economyMode}
          workspace={projectDir}
        />
      )}

      {showEconomyAlert && (
        <EconomyAlert
          budget={usage.budget}
          spent={usage.daily}
          onContinue={() => setShowEconomyAlert(false)}
          onReset={() => void handleResetEconomy()}
        />
      )}

      {dialog === 'newTask' && (
        <Modal title="Новая задача" onClose={() => setDialog('none')} width={480}>
          <NewTaskForm
            projectName={projectName}
            onSubmit={handleAddTask}
            onCancel={() => setDialog('none')}
          />
        </Modal>
      )}

      {dialog === 'newProject' && (
        <Modal title="Новый проект" onClose={() => setDialog('none')} width={440}>
          <NewProjectForm
            onSubmit={(name) => void handleCreateProject(name)}
            onCancel={() => setDialog('none')}
          />
        </Modal>
      )}

      {dialog === 'closeProject' && (
        <Modal title="Убрать проект" onClose={() => setDialog('none')} width={440}>
          <ConfirmDialog
            danger
            confirmLabel="Убрать из списка"
            text={
              <>
                Убрать проект «{projects.find((p) => p.id === pendingCloseId)?.name}» из списка?
                <br />
                <br />
                Задачи, память и переписка перестанут отображаться. Папка проекта и все
                файлы в ней <strong>останутся на диске</strong> — приложение ничего не удаляет.
              </>
            }
            onConfirm={() => void handleCloseProject()}
            onCancel={() => setDialog('none')}
          />
        </Modal>
      )}

      {pipeline?.status === 'awaiting_clarification' && (
        <Modal title="Аналитик уточняет" onClose={() => void handlePipelineStop()} width={520}>
          <ClarificationPrompt
            run={pipeline}
            onSubmit={(answer) => void handlePipelineAnswerClarification(answer)}
            onCancel={() => void handlePipelineStop()}
          />
        </Modal>
      )}

      {pipeline?.status === 'awaiting_analysis' && (
        <Modal
          title="Аналитик — делать или нет?"
          onClose={() => void handlePipelineStop()}
          width={520}
        >
          <AnalysisApproval
            run={pipeline}
            onApprove={() => void handlePipelineApproveAnalysis()}
            onReject={() => void handlePipelineStop()}
          />
        </Modal>
      )}

      {pipeline?.status === 'awaiting_plan' && (
        <Modal
          title="План работ — утвердите запуск"
          onClose={() => void handlePipelineStop()}
          width={680}
        >
          <PlanApproval
            run={pipeline}
            onApprove={(subtasks) => void handlePipelineApprove(subtasks)}
            onCancel={() => void handlePipelineStop()}
          />
        </Modal>
      )}

      {dialog === 'clearChat' && (
        <Modal title="Очистить диалог" onClose={() => setDialog('none')} width={420}>
          <ConfirmDialog
            danger
            confirmLabel="Очистить"
            text={
              <>
                Удалить все сообщения диалога с агентом «{activeAgent?.name ?? ''}» в проекте «
                {projectName}»?
                <br />
                <br />
                Действие необратимо.
              </>
            }
            onConfirm={() => void handleClearChat()}
            onCancel={() => setDialog('none')}
          />
        </Modal>
      )}

      {dialog === 'history' && (
        <Modal title="Поиск по диалогам" onClose={() => setDialog('none')} width={640}>
          <HistoryBrowser
            agentNames={agentNames}
            onOpen={async (pid, agentId) => {
              if (pid !== activeProjectId) await switchProject(pid)
              setActiveAgentId(agentId)
              setDialog('none')
            }}
          />
        </Modal>
      )}

      {dialog === 'about' && (
        <Modal title="О программе" onClose={() => setDialog('none')} width={460}>
          <AboutBox
            workspace={workspace}
            projectDir={projectDir}
            projects={projects}
            keyStatus={keyStatus}
            modelCount={allModels.length}
            liveModels={allModels.some((m) => m.live)}
          />
        </Modal>
      )}
    </div>
  )
}
