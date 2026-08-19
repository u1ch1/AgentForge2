import { describe, it, expect } from 'vitest'
import {
  extractJson,
  clampPct,
  parseAnalysis,
  renderAnalysis,
  parseAnalysisOutcome,
  renderClarification,
  parsePlan,
  renderPlan,
  indexOfMention,
  extractRequestedFiles,
  extractCritical,
  MAX_SUBTASKS,
  MAX_REQUESTED_FILES,
} from './pipeline-parsing'

describe('extractJson', () => {
  it('вырезает объект из markdown-ограды', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('вырезает объект без ограды, окружённый прозой', () => {
    expect(extractJson('Вот ответ: {"a":1} — готово')).toBe('{"a":1}')
  })

  it('вырезает массив по заданным скобкам', () => {
    expect(extractJson('```\n[1,2,3]\n```', '[', ']')).toBe('[1,2,3]')
  })

  it('возвращает null, если скобок нет вообще', () => {
    expect(extractJson('просто текст без JSON')).toBeNull()
  })

  it('возвращает null, если закрывающая скобка перед открывающей', () => {
    expect(extractJson('} мусор {')).toBeNull()
  })
})

describe('clampPct', () => {
  it('пропускает число в диапазоне как есть', () => {
    expect(clampPct(42)).toBe(42)
  })

  it('обрезает снизу до 0', () => {
    expect(clampPct(-15)).toBe(0)
  })

  it('обрезает сверху до 100', () => {
    expect(clampPct(250)).toBe(100)
  })

  it('округляет дробные значения', () => {
    expect(clampPct(66.6)).toBe(67)
  })

  it('парсит числовую строку', () => {
    expect(clampPct('80')).toBe(80)
  })

  it('нечисловое значение — 0', () => {
    expect(clampPct('много')).toBe(0)
    expect(clampPct(undefined)).toBe(0)
  })
})

describe('parseAnalysis', () => {
  const valid = JSON.stringify({
    feasibility: 72.4,
    coverage: 150,
    missing: ['доступ к платёжному шлюзу', '', '  ручной созвон с клиентом  '],
    summary: '  Задача в целом посильна.  ',
  })

  it('разбирает валидный ответ, клэмпит проценты и чистит missing/summary', () => {
    const result = parseAnalysis(`\`\`\`json\n${valid}\n\`\`\``)
    expect(result).toEqual({
      feasibility: 72,
      coverage: 100,
      missing: ['доступ к платёжному шлюзу', 'ручной созвон с клиентом'],
      summary: 'Задача в целом посильна.',
    })
  })

  it('возвращает null, если в тексте нет JSON', () => {
    expect(parseAnalysis('извините, не могу оценить')).toBeNull()
  })

  it('возвращает null, если JSON битый', () => {
    expect(parseAnalysis('{"feasibility": 10,')).toBeNull()
  })

  it('возвращает null без обязательных полей feasibility/coverage', () => {
    expect(parseAnalysis('{"summary": "текст"}')).toBeNull()
  })

  it('missing по умолчанию пустой массив, если поле не пришло', () => {
    const result = parseAnalysis('{"feasibility": 100, "coverage": 100}')
    expect(result?.missing).toEqual([])
  })
})

describe('renderAnalysis', () => {
  it('включает проценты, summary и список нехватки', () => {
    const text = renderAnalysis({
      feasibility: 80,
      coverage: 60,
      missing: ['доступ к API оплаты'],
      summary: 'В целом реально.',
    })
    expect(text).toContain('80%')
    expect(text).toContain('60%')
    expect(text).toContain('В целом реально.')
    expect(text).toContain('- доступ к API оплаты')
  })

  it('не пишет секцию нехватки, если missing пуст', () => {
    const text = renderAnalysis({ feasibility: 100, coverage: 100, missing: [], summary: '' })
    expect(text).not.toContain('Не хватает')
  })
})

describe('parseAnalysisOutcome', () => {
  it('распознаёт готовую оценку', () => {
    const outcome = parseAnalysisOutcome(
      JSON.stringify({ feasibility: 80, coverage: 70, missing: [], summary: 'Ок' })
    )
    expect(outcome).toEqual({
      kind: 'analysis',
      value: { feasibility: 80, coverage: 70, missing: [], summary: 'Ок' },
    })
  })

  it('распознаёт запрос уточнения по форме {question}', () => {
    const outcome = parseAnalysisOutcome(JSON.stringify({ question: '  Нужен веб или десктоп?  ' }))
    expect(outcome).toEqual({ kind: 'clarification', value: { question: 'Нужен веб или десктоп?' } })
  })

  it('пустой question считается невалидным ответом', () => {
    expect(parseAnalysisOutcome(JSON.stringify({ question: '   ' }))).toBeNull()
  })

  it('объект без question и без feasibility/coverage — null', () => {
    expect(parseAnalysisOutcome(JSON.stringify({ summary: 'непонятно что' }))).toBeNull()
  })

  it('возвращает null, если JSON не найден', () => {
    expect(parseAnalysisOutcome('простой текст без разметки')).toBeNull()
  })
})

describe('renderClarification', () => {
  it('оборачивает вопрос в заголовок', () => {
    const text = renderClarification('Нужна ли оплата картой?')
    expect(text).toContain('## Нужно уточнение')
    expect(text).toContain('Нужна ли оплата картой?')
  })
})

describe('parsePlan', () => {
  it('разбирает валидный план', () => {
    const plan = parsePlan(
      JSON.stringify({
        stack: 'React + FastAPI',
        subtasks: [
          { title: 'Форма логина', description: 'src/Login.tsx', assignee: 'frontend' },
          { title: 'Роут авторизации', description: 'api/auth.py', assignee: 'backend' },
        ],
      })
    )
    expect(plan?.stack).toBe('React + FastAPI')
    expect(plan?.subtasks).toHaveLength(2)
    expect(plan?.subtasks[0]).toMatchObject({
      title: 'Форма логина',
      assignee: 'frontend',
      status: 'pending',
      files: [],
    })
  })

  it('подзадачи без title отбрасываются', () => {
    const plan = parsePlan(JSON.stringify({ subtasks: [{ title: '  ', description: 'x' }] }))
    expect(plan).toBeNull()
  })

  it('незнакомый assignee считается backend', () => {
    const plan = parsePlan(JSON.stringify({ subtasks: [{ title: 'Что-то', assignee: 'devops' }] }))
    expect(plan?.subtasks[0].assignee).toBe('backend')
  })

  it('обрезает список по MAX_SUBTASKS', () => {
    const subtasks = Array.from({ length: MAX_SUBTASKS + 5 }, (_, i) => ({ title: `Задача ${i}` }))
    const plan = parsePlan(JSON.stringify({ subtasks }))
    expect(plan?.subtasks).toHaveLength(MAX_SUBTASKS)
  })

  it('возвращает null для пустого списка подзадач', () => {
    expect(parsePlan(JSON.stringify({ subtasks: [] }))).toBeNull()
  })

  it('возвращает null, если JSON вообще не найден', () => {
    expect(parsePlan('простой текст')).toBeNull()
  })
})

describe('renderPlan', () => {
  it('нумерует подзадачи и подписывает исполнителя', () => {
    const text = renderPlan('Node.js', [
      { id: '1', title: 'Сделать API', description: 'roues.ts', assignee: 'backend', status: 'pending', files: [] },
    ])
    expect(text).toContain('Node.js')
    expect(text).toContain('1. **Сделать API** — Worker2')
    expect(text).toContain('roues.ts')
  })
})

describe('indexOfMention', () => {
  it('находит файл на границе слова', () => {
    expect(indexOfMention('открой src/app.ts и поправь', 'src/app.ts')).toBeGreaterThanOrEqual(0)
  })

  it('не путает index.js с index.jsx', () => {
    expect(indexOfMention('нужен index.jsx', 'index.js')).toBe(-1)
  })

  it('не путает c.md, вложенный в spec.md', () => {
    expect(indexOfMention('файл spec.md', 'c.md')).toBe(-1)
  })

  it('возвращает -1, если совпадений нет', () => {
    expect(indexOfMention('ничего похожего', 'app.ts')).toBe(-1)
  })
})

describe('extractRequestedFiles', () => {
  const known = ['src/app.ts', 'src/utils/index.ts', 'src/components/index.ts']

  it('находит файл по полному пути', () => {
    expect(extractRequestedFiles('нужен файл src/app.ts', known)).toEqual(['src/app.ts'])
  })

  it('не берёт по одному имени файла, если оно неоднозначно', () => {
    // index.ts встречается в двух разных папках — по одному базовому имени не опознать.
    expect(extractRequestedFiles('пришлите index.ts', known)).toEqual([])
  })

  it('ограничивает число найденных файлов MAX_REQUESTED_FILES', () => {
    const many = Array.from({ length: MAX_REQUESTED_FILES + 5 }, (_, i) => `src/file${i}.ts`)
    const text = many.map((f) => `нужен ${f}`).join(', ')
    expect(extractRequestedFiles(text, many).length).toBe(MAX_REQUESTED_FILES)
  })

  it('пустой список, если ни один файл не назван', () => {
    expect(extractRequestedFiles('всё есть, вопросов нет', known)).toEqual([])
  })
})

describe('extractCritical', () => {
  it('вытаскивает строки с [CRITICAL]', () => {
    const report = [
      '[OK] стиль в порядке',
      '[CRITICAL] обработчик оплаты не проверяет подпись запроса',
      '[WARNING] не хватает тестов',
    ].join('\n')
    expect(extractCritical(report)).toEqual(['[CRITICAL] обработчик оплаты не проверяет подпись запроса'])
  })

  it('игнорирует строку-легенду со всеми тремя метками', () => {
    const legend = 'Отчёт формата: [CRITICAL] / [WARNING] / [OK]'
    expect(extractCritical(legend)).toEqual([])
  })

  it('игнорирует метку без содержательного текста', () => {
    expect(extractCritical('[CRITICAL]')).toEqual([])
    expect(extractCritical('[CRITICAL] коротко')).toEqual([])
  })

  it('без критических замечаний — пустой массив', () => {
    expect(extractCritical('[OK] всё хорошо\n[WARNING] мелочи')).toEqual([])
  })
})
