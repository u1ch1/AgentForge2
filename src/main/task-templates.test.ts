import { describe, it, expect } from 'vitest'
import { matchTaskTemplate, TASK_TEMPLATES } from './task-templates'

describe('matchTaskTemplate', () => {
  it('matches a landing page request', () => {
    expect(matchTaskTemplate('Сделай лендинг для кофейни')?.name).toBe('Лендинг / одностраничный сайт')
  })

  it('matches an online shop request', () => {
    expect(matchTaskTemplate('Интернет-магазин одежды с каталогом и корзиной')?.name).toBe(
      'Интернет-магазин / каталог'
    )
  })

  it('matches a CRUD admin panel request', () => {
    expect(matchTaskTemplate('Нужна CRUD админка для управления заказами')?.name).toBe(
      'CRUD-админка / панель управления'
    )
  })

  it('matches a Telegram bot request', () => {
    expect(matchTaskTemplate('Напиши Telegram бота для записи на приём')?.name).toBe('Telegram-бот')
  })

  it('matches a parser/scraper request', () => {
    expect(matchTaskTemplate('Парсер цен с сайта конкурента')?.name).toBe('Парсер / скрапер')
  })

  it('matches a blog/CMS request', () => {
    expect(matchTaskTemplate('Блог с новостями компании')?.name).toBe('Блог / контентный сайт')
  })

  it('returns null when nothing matches', () => {
    expect(matchTaskTemplate('Просто нарисуй логотип')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(matchTaskTemplate('ЛЕНДИНГ для стоматологии')?.name).toBe('Лендинг / одностраничный сайт')
  })

  it('every template has a non-empty name and outline', () => {
    for (const t of TASK_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.outline.length).toBeGreaterThan(0)
    }
  })
})
