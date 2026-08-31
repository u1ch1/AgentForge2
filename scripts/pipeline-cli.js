// Headless-управление конвейером: те же функции main-процесса (orchestrator.ts),
// что дёргает GUI по клику, только с терминала и без окна. Нужен, когда прогон
// удобнее вести из скрипта/агента, а не руками через интерфейс.
//
// Работает поверх собранного dist — сначала `npm run build`, иначе модули
// не найдутся.
//
// Запуск:
//   electron scripts/pipeline-cli.js <команда> [аргумент]
//
// Команды:
//   new-project "<имя>"     — создать проект и сделать активным
//   list-projects           — список проектов, * — активный
//   set-project <id>        — сделать проект активным
//   start "<цель>"          — запустить прогон для активного проекта
//   status                  — текущее состояние прогона активного проекта
//   answer "<ответ>"        — ответить на уточняющий вопрос Analyst
//   approve-analysis        — принять оценку Analyst, дальше план Admin
//   approve-plan            — утвердить план, дальше запись файлов и проверки
//   stop                    — остановить текущий прогон
//
// Один процесс конвейера на всё приложение (см. requestSingleInstanceLock в
// main.ts) — GUI и этот скрипт одновременно не уживутся, оба пишут в одни и
// те же файлы состояния. Перед запуском закрой GUI.

const { app } = require('electron')

// Без явного имени Electron, запущенный не как `electron .`, а как
// `electron scripts/pipeline-cli.js`, не подхватывает "name" из package.json
// сам — app.getPath('userData') уезжает в %APPDATA%/Electron вместо
// %APPDATA%/agentforge-studio, и весь main-процесс (ключи, проекты, прогоны)
// смотрит не в те файлы, что GUI.
app.setName('agentforge-studio')
app.on('window-all-closed', () => {})

function fail(message) {
  console.error(message)
  app.exit(1)
}

const BUSY = ['analyzing', 'planning', 'working', 'verifying', 'fixing']

function printRun(run) {
  if (!run) return console.log('Прогон не найден.')
  console.log(`\n=== Статус: ${run.status} ===`)
  if (run.analysis) {
    console.log(
      `Анализ: выполнимость ${run.analysis.feasibility}%, покрытие ${run.analysis.coverage}%`
    )
    if (run.analysis.missing.length > 0) console.log('Не хватает: ' + run.analysis.missing.join('; '))
    console.log(run.analysis.summary)
  }
  if (run.clarification && !run.clarification.answer) {
    console.log(`Вопрос аналитика: ${run.clarification.question}`)
  }
  if (run.stack) console.log(`Стек: ${run.stack}`)
  if (run.subtasks.length > 0) {
    console.log('План:')
    for (const s of run.subtasks) console.log(`  [${s.status}] (${s.assignee}) ${s.title}`)
  }
  if (run.checks) console.log(`Проверки: ${run.checks.summary}`)
  if (run.review && run.review.critical.length > 0) {
    console.log('Критично: ' + run.review.critical.join('; '))
  }
}

/** Печатает новые записи лога по мере появления и ждёт, пока прогон не встанет на гейт/не завершится. */
async function watch(orchestrator) {
  let printed = 0
  for (;;) {
    const run = orchestrator.getRun()
    if (!run) {
      console.log('Прогон не найден.')
      return
    }
    for (; printed < run.log.length; printed++) {
      const e = run.log[printed]
      const tag = e.agent ? `[${e.agent}] ` : ''
      console.log(`${tag}${e.text}`)
    }
    if (!BUSY.includes(run.status)) {
      printRun(run)
      return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    fail(
      'AgentForge Studio уже запущен (GUI или другой headless-прогон). ' +
        'Закройте его перед использованием pipeline-cli — оба пишут в одни и те же файлы.'
    )
    return
  }

  await app.whenReady()

  const { seedWorkspace } = require('../dist/main/file-manager')
  const { loadPersistedKeys } = require('../dist/main/api-client')
  const projects = require('../dist/main/projects')
  const orchestrator = require('../dist/main/orchestrator')

  seedWorkspace()
  loadPersistedKeys()

  const [, , cmd, ...rest] = process.argv
  const arg = rest.join(' ').trim()

  switch (cmd) {
    case 'new-project': {
      if (!arg) return fail('Укажите имя проекта: new-project "Имя"')
      const p = projects.createProject(arg)
      console.log(`Создан проект: ${p.name} (id=${p.id}, папка=${p.slug})`)
      break
    }
    case 'list-projects': {
      const activeId = projects.getActiveProjectId()
      for (const p of projects.listProjects()) {
        console.log(`${p.id === activeId ? '*' : ' '} ${p.id}  ${p.name}  (${p.slug})`)
      }
      break
    }
    case 'set-project': {
      if (!arg) return fail('Укажите id проекта: set-project <id>')
      const p = projects.setActiveProject(arg)
      if (!p) return fail(`Проект не найден: ${arg}`)
      console.log(`Активный проект: ${p.name} (${p.id})`)
      break
    }
    case 'start': {
      if (!arg) return fail('Укажите цель: start "текст задачи"')
      console.log(`Проект: ${projects.getActiveProject().name}`)
      orchestrator.startPipeline(arg)
      await watch(orchestrator)
      break
    }
    case 'status': {
      printRun(orchestrator.getRun())
      break
    }
    case 'answer': {
      if (!arg) return fail('Укажите ответ: answer "текст"')
      orchestrator.answerClarification(arg)
      await watch(orchestrator)
      break
    }
    case 'approve-analysis': {
      orchestrator.approveAnalysis()
      await watch(orchestrator)
      break
    }
    case 'approve-plan': {
      orchestrator.approvePlan()
      await watch(orchestrator)
      break
    }
    case 'stop': {
      orchestrator.stopPipeline()
      console.log('Остановлено.')
      break
    }
    default:
      return fail(
        `Неизвестная команда: ${cmd || '(пусто)'}\n` +
          'Доступно: new-project, list-projects, set-project, start, status, answer, approve-analysis, approve-plan, stop'
      )
  }

  app.exit(0)
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)))
