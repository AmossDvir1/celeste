export interface Integration {
  id: string
  name: string
  blurb: string
  /** A monogram tile, so no vendor logos are needed. */
  letter: string
  color: string
  tools: string[]
}

export const INTEGRATIONS: Integration[] = [
  { id: 'github', name: 'GitHub', blurb: 'Repositories, PRs, issues', letter: 'G', color: '#8b7cf6', tools: ['Search repositories', 'Get pull request', 'List review comments', 'Create issue', 'Read file'] },
  { id: 'atlassian', name: 'Atlassian', blurb: 'Jira, Confluence, Rovo', letter: 'A', color: '#4c9aff', tools: ['Get issue', 'Search issues', 'Add comment', 'Read Confluence page'] },
  { id: 'jfrog', name: 'JFrog', blurb: 'Artifacts and packages', letter: 'J', color: '#7ac14f', tools: ['Search artifacts', 'Get package info', 'List repositories'] },
  { id: 'playwright', name: 'Playwright', blurb: 'Browser automation', letter: 'P', color: '#45b36b', tools: ['Open page', 'Click', 'Type', 'Take screenshot'] },
  { id: 'figma', name: 'Figma', blurb: 'Design files and context', letter: 'F', color: '#f06292', tools: ['Get file', 'Get node', 'Export image'] },
  { id: 'okd', name: 'OKD', blurb: 'Clusters and resources', letter: 'O', color: '#ef5350', tools: ['List pods', 'Get logs', 'Describe resource'] },
  { id: 'harness', name: 'Harness', blurb: 'Deployments and pipelines', letter: 'H', color: '#29b6f6', tools: ['List pipelines', 'Run pipeline', 'Get execution'] },
  { id: 'gravitee', name: 'Gravitee', blurb: 'API management', letter: 'G', color: '#ffb74d', tools: ['List APIs', 'Get API definition'] },
  { id: 'datadog', name: 'Datadog', blurb: 'Logs, metrics and alerts', letter: 'D', color: '#9575cd', tools: ['Search logs', 'Query metrics', 'List monitors'] },
  { id: 'sqlserver', name: 'SQL Server', blurb: 'Query and analyze', letter: 'S', color: '#e57373', tools: ['Run read-only query', 'Describe table'] }
]

export const PROJECTS = [
  { path: 'D:\\Work\\wfo-tools', branch: 'main' },
  { path: 'D:\\Work\\shop-web', branch: 'fix/flaky-checkout' },
  { path: 'D:\\Work\\kb-scanner', branch: 'main' },
  { path: 'D:\\Projects\\celeste', branch: 'main' }
]
