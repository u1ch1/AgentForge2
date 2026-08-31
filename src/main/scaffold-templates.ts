/**
 * Базовый каркас проекта — файлы, которые агенты и так писали бы одинаково
 * при старте почти каждой задачи (конфиг Vite, tsconfig, Tailwind, скелет
 * Express-сервера). Раскладываются программно, без единого токена LLM, прямо
 * перед тем как воркеры возьмутся за первую подзадачу — см. applyScaffold()
 * в scaffold.ts и её вызов в runRemainder() (orchestrator.ts).
 *
 * Версии зависимостей взяты из уже проверенного в бою прогона (реальный
 * магазин одежды, собрался и запустился без правок).
 *
 * Осознанно НЕ включено: react-router-dom (не всем проектам нужен роутинг —
 * это архитектурное решение, а не одинаковый для всех каркас), eslint
 * (Тестер его не запускает — planChecks в command-runner.ts проверяет только
 * typecheck/build/test), sqlite3/любая БД на бэкенде (выбор хранилища —
 * тоже решение по задаче, не универсальная заготовка).
 */

export const FRONTEND_SCAFFOLD: Record<string, string> = {
  'package.json': `{
  "name": "frontend",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host",
    "start": "vite --host",
    "build": "tsc && vite build",
    "preview": "vite preview --host",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.55",
    "@types/react-dom": "^18.2.19",
    "@typescript-eslint/eslint-plugin": "^6.21.0",
    "@typescript-eslint/parser": "^6.21.0",
    "@vitejs/plugin-react": "^4.2.1",
    "autoprefixer": "^10.4.17",
    "eslint": "^8.56.0",
    "eslint-plugin-react-hooks": "^4.6.0",
    "eslint-plugin-react-refresh": "^0.4.5",
    "postcss": "^8.4.35",
    "tailwindcss": "^3.4.1",
    "typescript": "^5.3.3",
    "vite": "^5.1.0"
  }
}
`,
  '.eslintrc.cjs': `module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
}
`,
  'vite.config.ts': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
`,
  'tsconfig.node.json': `{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
`,
  'tailwind.config.js': `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
}
`,
  'postcss.config.js': `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`,
  'index.html': `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  'src/main.tsx': `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`,
  'src/App.tsx': `export default function App() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <p className="text-gray-400">TODO: собрать приложение</p>
    </div>
  )
}
`,
  'src/index.css': `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
  'src/vite-env.d.ts': `/// <reference types="vite/client" />
`,
  '.gitignore': `node_modules
dist
.env
`,
}

export const BACKEND_SCAFFOLD: Record<string, string> = {
  'package.json': `{
  "name": "backend",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2"
  }
}
`,
  'server.js': `const express = require('express')
const cors = require('cors')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

// TODO: подключить роуты приложения — app.use('/api/...', router)

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body' })
  }
  next(err)
})

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// 0.0.0.0, а не голый "localhost": на части Windows-машин это два разных
// сетевых стека (IPv4/IPv6), и явный адрес снимает вопрос, кто где слушает.
app.listen(PORT, '0.0.0.0', () => {
  console.log(\`Server is running on http://127.0.0.1:\${PORT}\`)
})
`,
  '.gitignore': `node_modules
.env
*.sqlite
`,
}

/**
 * Выбирается вместо BACKEND_SCAFFOLD, когда Admin сам написал в стеке
 * FastAPI/Django/Flask/Python (см. pickBackendTemplate в scaffold.ts).
 * Имя входного файла (main.py) и наличие "uvicorn" в requirements.txt не
 * случайны — именно по ним pythonLaunchPlan() в live-preview.ts опознаёт,
 * как поднимать «Просмотр» для этого проекта.
 */
export const PYTHON_BACKEND_SCAFFOLD: Record<string, string> = {
  'requirements.txt': `fastapi
uvicorn[standard]
`,
  'main.py': `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True}


# TODO: подключить роуты приложения — app.include_router(...)
`,
  '.gitignore': `__pycache__/
*.pyc
.venv
.env
`,
}
