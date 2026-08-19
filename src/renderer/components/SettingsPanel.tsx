import { useState, useEffect } from 'react'
import type { Agent, AllModels, AppSettings, KeyStatus, UsageInfo } from '../types'
import { providerForModel, agentIcon } from '../types'
import { ps, fonts, input, select, button, buttonPrimary, notice, well } from '../theme'
import { GroupLabel, Row } from './PanelChrome'
import { Icon, StatusDot } from '../icons'
import { Toggle } from './ChatSettingsMenu'

const KIMI_ENDPOINTS = [
  { value: 'https://api.moonshot.ai/v1', label: 'api.moonshot.ai — международный' },
  { value: 'https://api.moonshot.cn/v1', label: 'api.moonshot.cn — Китай' },
]

interface SettingsPanelProps {
  agents: Agent[]
  keyStatus: KeyStatus
  usage: UsageInfo
  settings: AppSettings
  workspace: string
  models: AllModels
  onSaveKey: (provider: 'claude' | 'kimi', key: string) => Promise<void>
  onSetAgentModel: (agentId: string, model: string) => Promise<void>
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>
  onChooseWorkspace: () => Promise<void>
  onResetEconomy: () => Promise<void>
  onRefreshModels: () => Promise<void>
  onTestKey: (provider: 'claude' | 'kimi') => Promise<{ ok: boolean; message: string }>
}

function KeyField({
  provider,
  title,
  placeholder,
  isSet,
  modelCount,
  error,
  onSave,
  onTest,
}: {
  provider: 'claude' | 'kimi'
  title: string
  placeholder: string
  isSet: boolean
  modelCount: number
  error?: string
  onSave: (key: string) => Promise<void>
  onTest: () => Promise<{ ok: boolean; message: string }>
}) {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const save = async () => {
    if (!value.trim()) return
    setBusy(true)
    try {
      await onSave(value.trim())
      setValue('')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    try {
      setResult(await onTest())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: '0 8px 10px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginBottom: '4px',
          fontSize: '11px',
        }}
      >
        <StatusDot color={isSet ? ps.ok : ps.textFaint} />
        <span style={{ color: ps.text, flex: 1 }}>{title}</span>
        <span style={{ color: ps.textFaint, fontSize: '10px' }}>
          {isSet ? `${modelCount} моделей` : 'ключ не задан'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '4px' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          placeholder={placeholder}
          style={{ ...input, flex: 1, fontFamily: fonts.mono }}
        />
        <button
          onClick={() => setShow(!show)}
          style={{ ...button, width: '24px', padding: 0 }}
          title={show ? 'Скрыть' : 'Показать'}
        >
          <Icon name="eye" size={12} />
        </button>
        <button
          onClick={() => void save()}
          disabled={!value.trim() || busy}
          style={value.trim() && !busy ? buttonPrimary : { ...button, opacity: 0.5 }}
        >
          <Icon name="key" size={12} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
        <button
          onClick={() => void test()}
          disabled={!isSet || busy}
          style={isSet && !busy ? button : { ...button, opacity: 0.5, cursor: 'default' }}
        >
          {busy ? 'Проверка…' : 'Проверить ключ'}
        </button>
        <span style={{ flex: 1 }} />
      </div>

      {(result || error) && (
        <div style={{ marginTop: '5px' }}>
          <div style={notice(result ? (result.ok ? 'ok' : 'err') : 'err')}>
            {result?.message ?? `${provider === 'claude' ? 'Anthropic' : 'Moonshot'}: ${error}`}
          </div>
        </div>
      )}
    </div>
  )
}

export default function SettingsPanel({
  agents,
  keyStatus,
  usage,
  settings,
  workspace,
  models,
  onSaveKey,
  onSetAgentModel,
  onUpdateSettings,
  onChooseWorkspace,
  onResetEconomy,
  onRefreshModels,
  onTestKey,
}: SettingsPanelProps) {
  const [budget, setBudget] = useState(String(settings.dailyBudget))
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => setBudget(String(settings.dailyBudget)), [settings.dailyBudget])

  const allModels = [...models.claude.models, ...models.kimi.models]
  const live = models.claude.models.some((m) => m.live) || models.kimi.models.some((m) => m.live)

  return (
    <div>
      <GroupLabel>Ключи провайдеров</GroupLabel>
      <KeyField
        provider="claude"
        title="Anthropic — Claude"
        placeholder="sk-ant-…"
        isSet={keyStatus.claude}
        modelCount={models.claude.models.length}
        error={keyStatus.claude ? models.claude.error : undefined}
        onSave={(k) => onSaveKey('claude', k)}
        onTest={() => onTestKey('claude')}
      />
      <KeyField
        provider="kimi"
        title="Moonshot — Kimi"
        placeholder="sk-…"
        isSet={keyStatus.kimi}
        modelCount={models.kimi.models.length}
        error={keyStatus.kimi ? models.kimi.error : undefined}
        onSave={(k) => onSaveKey('kimi', k)}
        onTest={() => onTestKey('kimi')}
      />
      <div style={{ padding: '0 8px 10px' }}>
        <div style={notice(keyStatus.persistent ? 'info' : 'err')}>
          {keyStatus.persistent
            ? 'Ключи шифруются средствами ОС и сохраняются между запусками.'
            : 'ОС не предоставляет шифрование — ключи хранятся только в памяти и нужны заново после перезапуска.'}
        </div>
      </div>

      <GroupLabel>Эндпоинт Moonshot</GroupLabel>
      <div style={{ padding: '0 8px 4px' }}>
        <select
          value={settings.kimiBaseUrl}
          onChange={(e) => void onUpdateSettings({ kimiBaseUrl: e.target.value })}
          style={select}
        >
          {/* Если в настройках лежит адрес не из списка, показываем его явно:
              иначе select молча отрисует первый вариант, и адрес будет
              выглядеть не тем, который используется на самом деле. */}
          {!KIMI_ENDPOINTS.some((e) => e.value === settings.kimiBaseUrl) && (
            <option value={settings.kimiBaseUrl}>{settings.kimiBaseUrl} — свой</option>
          )}
          {KIMI_ENDPOINTS.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ padding: '0 8px 10px', color: ps.textDisabled, fontSize: '10px', lineHeight: 1.6 }}>
        Ключ с platform.moonshot.cn не работает на api.moonshot.ai и наоборот.
      </div>

      <GroupLabel>Модели агентов</GroupLabel>
      <div style={{ padding: '0 8px 6px' }}>
        <div style={{ ...well, padding: '4px 6px', fontSize: '10px', color: ps.textFaint }}>
          {live
            ? `Список получен от API провайдеров: ${allModels.length} моделей.`
            : 'Показан встроенный список — задайте ключ и обновите, чтобы увидеть доступные вам модели.'}
        </div>
      </div>
      {agents.map((agent) => {
        const provider = providerForModel(agent.model)
        const list = models[provider].models
        const options = list.some((m) => m.id === agent.model)
          ? list
          : [{ id: agent.model, label: `${agent.model} (нет в списке)`, provider, live: false }, ...list]
        return (
          <Row key={agent.id} label={agent.name}>
            <span style={{ color: ps.textDim, display: 'flex', flexShrink: 0 }}>
              <Icon name={agentIcon(agent.icon)} size={13} />
            </span>
            <select
              value={agent.model}
              onChange={(e) => void onSetAgentModel(agent.id, e.target.value)}
              disabled={usage.economyMode}
              style={{ ...select, opacity: usage.economyMode ? 0.55 : 1 }}
            >
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Row>
        )
      })}
      <div style={{ padding: '6px 8px 10px' }}>
        <button
          onClick={async () => {
            setRefreshing(true)
            try {
              await onRefreshModels()
            } finally {
              setRefreshing(false)
            }
          }}
          disabled={refreshing}
          style={refreshing ? { ...button, opacity: 0.6, cursor: 'wait' } : button}
        >
          <Icon name="refresh" size={12} />
          {refreshing ? 'Обновление…' : 'Обновить список моделей'}
        </button>
      </div>

      <GroupLabel>Бюджет</GroupLabel>
      <Row label="Лимит, $">
        <input
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={() => {
            const n = Number(budget)
            if (Number.isFinite(n) && n > 0) void onUpdateSettings({ dailyBudget: n })
            else setBudget(String(settings.dailyBudget))
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          inputMode="decimal"
          style={{ ...input, fontFamily: fonts.mono }}
        />
      </Row>
      <Row label="Потрачено">
        <span style={{ fontFamily: fonts.mono, color: ps.text }}>${usage.daily.toFixed(4)}</span>
        {usage.economyMode && (
          <span style={{ color: ps.warn, fontSize: '10px', marginLeft: '6px' }}>эконом-режим</span>
        )}
      </Row>
      <div style={{ padding: '4px 8px 10px' }}>
        <button onClick={() => void onResetEconomy()} style={button}>
          <Icon name="refresh" size={12} />
          Обнулить счётчик
        </button>
      </div>

      <GroupLabel>Просмотр</GroupLabel>
      <Row label="Автозапуск при старте приложения">
        <Toggle
          checked={settings.previewAutoStart}
          onChange={(v) => void onUpdateSettings({ previewAutoStart: v })}
        />
      </Row>
      <div style={{ padding: '0 8px 10px', color: ps.textDisabled, fontSize: '10px', lineHeight: 1.6 }}>
        Поднимать <span style={{ fontFamily: fonts.mono }}>npm run dev</span> активного проекта
        сразу при запуске приложения — панель «Просмотр» покажет результат без нажатия «Старт».
      </div>

      <GroupLabel>Рабочая папка</GroupLabel>
      <div style={{ padding: '0 8px 6px' }}>
        <div
          style={{
            ...well,
            padding: '5px 6px',
            fontFamily: fonts.mono,
            fontSize: '10px',
            color: ps.textDim,
            wordBreak: 'break-all',
          }}
        >
          {workspace}
        </div>
      </div>
      <div style={{ padding: '0 8px 10px', display: 'flex', gap: '5px' }}>
        <button onClick={() => void onChooseWorkspace()} style={{ ...button, flex: 1 }}>
          Выбрать другую
        </button>
        <button onClick={() => void window.electronAPI.revealWorkspace()} style={button}>
          <Icon name="external" size={12} />
        </button>
      </div>
      <div style={{ padding: '0 8px 12px', color: ps.textDisabled, fontSize: '10px', lineHeight: 1.6 }}>
        Здесь живут .claude/, frontend/, backend/, deploy/. Панели «Файлы проекта»
        и «Просмотр» не выходят за пределы этой папки.
      </div>
    </div>
  )
}
