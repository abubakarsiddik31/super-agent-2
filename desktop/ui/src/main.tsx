/** Standalone entry: mounts the panel without the DeepSeek Harness shell. */
import { createRoot } from 'react-dom/client'
import { configureApi } from '../../../src/client/api.ts'
import { App } from '../../../src/client/app.tsx'
import { makeT, pickLanguage } from './i18n.ts'
import './tokens.css'

// The standalone host puts its panel token in the page; the development server adds it to the request instead, so there is none.
const embedded = document.querySelector<HTMLMetaElement>('meta[name="superagent-token"]')?.content
if (embedded) configureApi({ token: () => embedded })

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root')
// Without the DSH web UI there is no Session to open and no plugin configuration form, so those controls are hidden or read-only.
createRoot(root).render(<App t={makeT(pickLanguage())} sessionLinks={false} deploymentForm={undefined} />)
