import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectStack } from './live-preview'

const tmpDirs: string[] = []

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-detect-stack-'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('detectStack', () => {
  it('recognizes a Node project via package.json', () => {
    expect(detectStack(makeDir({ 'package.json': '{}' }))).toBe('node')
  })

  it('recognizes a Laravel project via artisan', () => {
    expect(detectStack(makeDir({ artisan: '' }))).toBe('php')
  })

  it('recognizes a plain PHP project via composer.json', () => {
    expect(detectStack(makeDir({ 'composer.json': '{}' }))).toBe('php')
  })

  it('recognizes a Django project via manage.py', () => {
    expect(detectStack(makeDir({ 'manage.py': '' }))).toBe('python')
  })

  it('recognizes a Python project via requirements.txt', () => {
    expect(detectStack(makeDir({ 'requirements.txt': 'fastapi\n' }))).toBe('python')
  })

  it('recognizes a Python project via pyproject.toml', () => {
    expect(detectStack(makeDir({ 'pyproject.toml': '' }))).toBe('python')
  })

  it('recognizes a static site via a bare index.html', () => {
    expect(detectStack(makeDir({ 'index.html': '<html></html>' }))).toBe('static')
  })

  it('prefers node over static when both package.json and index.html are present', () => {
    expect(detectStack(makeDir({ 'package.json': '{}', 'index.html': '<html></html>' }))).toBe('node')
  })

  it('prefers php over static when both composer.json and index.html are present', () => {
    expect(detectStack(makeDir({ 'composer.json': '{}', 'index.html': '<html></html>' }))).toBe('php')
  })

  it('returns null for an empty/unrecognized folder', () => {
    expect(detectStack(makeDir({ 'README.md': 'hello' }))).toBeNull()
  })
})
