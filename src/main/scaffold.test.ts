import { describe, it, expect } from 'vitest'
import { pickScaffoldTargets, pickBackendTemplate } from './scaffold'
import { BACKEND_SCAFFOLD, PYTHON_BACKEND_SCAFFOLD } from './scaffold-templates'

describe('pickScaffoldTargets', () => {
  it('picks frontend when its description references frontend/', () => {
    const subtasks = [{ assignee: 'frontend' as const, description: 'Создать frontend/src/App.tsx' }]
    expect(pickScaffoldTargets(subtasks)).toEqual(['frontend'])
  })

  it('picks both when both reference their own subfolder', () => {
    const subtasks = [
      { assignee: 'frontend' as const, description: 'Создать frontend/src/App.tsx' },
      { assignee: 'backend' as const, description: 'Создать backend/server.js' },
    ]
    expect(pickScaffoldTargets(subtasks)).toEqual(['frontend', 'backend'])
  })

  it('skips an assignee whose description has no folder prefix (single-root layout)', () => {
    const subtasks = [{ assignee: 'backend' as const, description: 'Написать parser.py' }]
    expect(pickScaffoldTargets(subtasks)).toEqual([])
  })

  it('returns empty for a pure Python script task with no frontend/backend paths', () => {
    const subtasks = [
      { assignee: 'backend' as const, description: 'main.py: скачать страницу и распарсить цены' },
    ]
    expect(pickScaffoldTargets(subtasks)).toEqual([])
  })

  it('does not false-positive on unrelated substrings (e.g. "backend" without slash)', () => {
    const subtasks = [{ assignee: 'backend' as const, description: 'Настроить backend-логику без подпапок' }]
    expect(pickScaffoldTargets(subtasks)).toEqual([])
  })
})

describe('pickBackendTemplate', () => {
  it('defaults to the Express template for an unlabeled/JS stack', () => {
    expect(pickBackendTemplate('Node.js + Express + SQLite')).toBe(BACKEND_SCAFFOLD)
  })

  it('picks the FastAPI template when the stack mentions FastAPI', () => {
    expect(pickBackendTemplate('React + FastAPI + PostgreSQL')).toBe(PYTHON_BACKEND_SCAFFOLD)
  })

  it('picks the FastAPI template for Django too', () => {
    expect(pickBackendTemplate('Django + PostgreSQL')).toBe(PYTHON_BACKEND_SCAFFOLD)
  })

  it('returns null for PHP/Laravel — no authored scaffold', () => {
    expect(pickBackendTemplate('PHP + Laravel + MySQL')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(pickBackendTemplate('python + flask')).toBe(PYTHON_BACKEND_SCAFFOLD)
  })
})
