import { useEffect, useRef, type ReactNode } from 'react'
import type { AppSettings } from '../types'
import { ps, fonts } from '../theme'

interface ChatSettingsMenuProps {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

/** Тумблер вместо нативного чекбокса — в духе плотных панелей Photoshop. */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      style={{
        width: '30px',
        height: '16px',
        borderRadius: '8px',
        border: `1px solid ${checked ? ps.accent : ps.borderLight}`,
        background: checked ? ps.accent : '#454545',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '1px',
          left: checked ? '15px' : '1px',
          width: '12px',
          height: '12px',
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.12s',
        }}
      />
    </button>
  )
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px' }}>
      <span style={{ flex: 1, fontSize: '11px', color: ps.text }}>{label}</span>
      {children}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        border: `1px solid ${ps.borderLight}`,
        borderRadius: '2px',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {options.map((opt, i) => {
        const active = opt.id === value
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            style={{
              padding: '3px 8px',
              border: 'none',
              borderRight: i < options.length - 1 ? `1px solid ${ps.borderLight}` : 'none',
              background: active ? ps.accent : '#3a3a3a',
              color: active ? '#fff' : ps.textDim,
              fontSize: '10px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function GroupTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: '10px',
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        color: ps.textFaint,
        padding: '7px 10px 3px',
      }}
    >
      {children}
    </div>
  )
}

/**
 * Выпадающая панель настроек чата — открывается из строки инструментов над
 * диалогом. Настройки применяются сразу и хранятся в общем app-settings.json,
 * поэтому переживают перезапуск и одинаковы для всех агентов и проектов.
 */
export default function ChatSettingsMenu({ settings, onChange, onClose }: ChatSettingsMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: '4px',
        width: '264px',
        background: ps.menuPopup,
        border: `1px solid ${ps.borderDark}`,
        boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
        zIndex: 300,
        fontFamily: fonts.ui,
        padding: '2px 0 6px',
      }}
    >
      <GroupTitle>Вид сообщений</GroupTitle>
      <SettingRow label="Размер текста">
        <Segmented
          value={settings.chatFontSize}
          onChange={(v) => onChange({ chatFontSize: v })}
          options={[
            { id: 'small', label: 'S' },
            { id: 'medium', label: 'M' },
            { id: 'large', label: 'L' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Ширина">
        <Segmented
          value={settings.chatWidth}
          onChange={(v) => onChange({ chatWidth: v })}
          options={[
            { id: 'comfortable', label: 'Читаемая' },
            { id: 'full', label: 'Широкая' },
          ]}
        />
      </SettingRow>

      <div style={{ height: '1px', background: ps.border, margin: '4px 0' }} />

      <GroupTitle>Метаданные сообщений</GroupTitle>
      <SettingRow label="Показывать время">
        <Toggle
          checked={settings.chatShowTimestamps}
          onChange={(v) => onChange({ chatShowTimestamps: v })}
        />
      </SettingRow>
      <SettingRow label="Показывать модель в ответах">
        <Toggle
          checked={settings.chatShowModelBadge}
          onChange={(v) => onChange({ chatShowModelBadge: v })}
        />
      </SettingRow>

      <div style={{ height: '1px', background: ps.border, margin: '4px 0' }} />

      <GroupTitle>Уведомления</GroupTitle>
      <SettingRow label="Звук по завершении ответа">
        <Toggle checked={settings.chatSound} onChange={(v) => onChange({ chatSound: v })} />
      </SettingRow>
    </div>
  )
}
