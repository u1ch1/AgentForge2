import * as fs from 'fs'
import * as path from 'path'
import { resolveInProject } from './projects'
import type { Assignee } from '../shared/pipeline'
import { FRONTEND_SCAFFOLD, BACKEND_SCAFFOLD, PYTHON_BACKEND_SCAFFOLD } from './scaffold-templates'

/**
 * Бэкенд может быть на трёх разных стеках — угадываем по тексту, который сам
 * же Admin написал в run.stack. PHP/Laravel и WordPress сюда осознанно не
 * входят: чтобы дать рабочий каркас Laravel-проекта, нужно воспроизвести
 * autoloading через composer.json (PSR-4), bootstrap/app.php и структуру
 * artisan — слишком легко ошибиться в файле, который потом никто не
 * проверит на реальном PHP (на машине разработки его просто нет), лучше
 * пусть воркер соберёт его сам обычным `composer create-project`, чем
 * получит от нас нерабочий скелет. Для WordPress ситуация ещё жёстче: там
 * нет не только PHP, но и самого ядра WordPress с MySQL, чтобы вообще было
 * куда класть тему/плагин — Vite/Express-каркас тут просто нерелевантен.
 */
export function pickBackendTemplate(stackText: string): Record<string, string> | null {
  if (/php|laravel|wordpress|вордпресс/i.test(stackText)) return null
  if (/fastapi|django|flask|python/i.test(stackText)) return PYTHON_BACKEND_SCAFFOLD
  return BACKEND_SCAFFOLD
}

/**
 * Не у каждого прогона такая раскладка: часть проектов — Python-скрипты без
 * какого-либо frontend/backend вовсе, часть — веб-код прямо в корне проекта
 * без разделения на подпапки. Раскладывать сюда Vite/Express в таких случаях
 * значит подсунуть Тестеру чужой package.json, который он честно попытается
 * собрать. Поэтому берём подпапку в работу только если Admin сам её уже
 * называет в описании подзадачи (по правилу PLAN_INSTRUCTION он обязан
 * указывать конкретные пути) — то есть план и так рассчитан на этот стек и
 * эту раскладку, а не только на роль "frontend"/"backend" как таковую.
 */
export function pickScaffoldTargets(subtasks: { assignee: Assignee; description: string }[]): Assignee[] {
  return (['frontend', 'backend'] as const).filter((a) =>
    subtasks.some((s) => s.assignee === a && new RegExp(`\\b${a}/`).test(s.description))
  )
}

/**
 * Раскладывает базовый каркас для тех исполнителей, чей план уже рассчитан
 * на разбивку frontend/backend (см. pickScaffoldTargets) — фронтенд всегда
 * Vite+React+TS+Tailwind, бэкенд выбирается по run.stack (Express/FastAPI/
 * ничего для PHP, см. pickBackendTemplate). План уже утверждён, runRemainder()
 * ещё не начал очередь воркеров (см. вызов в orchestrator.ts). Ничего не
 * трогает, если файл уже есть: повторный прогон
 * по тому же проекту или заранее принесённый пользователем код никогда не
 * перезаписывается.
 *
 * Раньше это была первая подзадача почти в каждом таком плане — Admin просил
 * Worker1 "настроить Vite + Tailwind + TS", хотя эта настройка не меняется
 * от задачи к задаче. Теперь воркер сразу получает рабочий каркас и пишет
 * только то, что специфично для конкретного проекта.
 */
export function applyScaffold(
  projectId: string,
  stackText: string,
  subtasks: { assignee: Assignee; description: string }[]
): string[] {
  const written: string[] = []

  for (const assignee of pickScaffoldTargets(subtasks)) {
    const template = assignee === 'frontend' ? FRONTEND_SCAFFOLD : pickBackendTemplate(stackText)
    if (!template) continue
    const base = resolveInProject(assignee, projectId)
    if (!base) continue

    for (const [relPath, content] of Object.entries(template)) {
      const full = path.join(base, relPath)
      if (fs.existsSync(full)) continue
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, content, 'utf-8')
        written.push(`${assignee}/${relPath}`)
      } catch {
        // Не смогли записать один файл каркаса — не фатально, воркер напишет его сам.
      }
    }
  }

  return written
}
