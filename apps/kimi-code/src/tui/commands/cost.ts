/**
 * /cost — show a detailed cost breakdown panel in the transcript.
 */

import chalk from 'chalk'
import type { SlashCommandHost } from './dispatch'
import { UsagePanelComponent } from '../components/messages/usage-panel'
import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
} from '#/utils/usage/usage-format'

export async function handleCostCommand(host: SlashCommandHost): Promise<void> {
  const snapshot = host.state.appState.statusSnapshot
  if (snapshot === null || snapshot === undefined) {
    host.showStatus('No status snapshot available yet.')
    return
  }

  const colors = host.state.theme.colors
  const accent = chalk.hex(colors.primary).bold
  const value = chalk.hex(colors.text)
  const muted = chalk.hex(colors.textDim)
  const errorStyle = chalk.hex(colors.error)
  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success

  const lines: string[] = []

  // Total cost + budget
  const cost = snapshot.cost
  if (cost !== null) {
    lines.push(accent('Session cost'))
    const budgetLine = cost.budgetRemaining !== undefined
      ? `Budget remaining: $${cost.budgetRemaining.toFixed(2)}`
      : 'No budget set'
    lines.push(`  Total: ${value(`$${cost.totalDollars.toFixed(4)}`)}  ${muted(budgetLine)}`)

    // Progress bar when budget is set
    if (cost.fractionUsed !== undefined && cost.budgetRemaining !== undefined) {
      const ratio = safeUsageRatio(cost.fractionUsed)
      const bar = renderProgressBar(ratio, 20)
      const pct = `${(ratio * 100).toFixed(0)}%`
      const barColoured = chalk.hex(severityHex(ratioSeverity(ratio)))(bar)
      lines.push(
        `  ${barColoured}  ${value(pct.padStart(4, ' '))}  ` +
          muted(`($${cost.totalDollars.toFixed(2)} / $${(cost.totalDollars + cost.budgetRemaining).toFixed(2)})`),
      )
    }
  } else {
    lines.push(muted('No cost data available yet.'))
  }

  // Burn rate
  if (snapshot.health !== null) {
    lines.push('')
    lines.push(accent('Burn rate'))
    lines.push(
      `  ${value(`${Math.round(snapshot.health.tokenBurnRate)} tok/min`)}  ${muted('avg turn')} ${value(`${(snapshot.health.avgTurnDuration / 1000).toFixed(1)}s`)}`,
    )
  }

  // Per-model breakdown
  if (cost !== null && cost.byModel !== undefined) {
    const models = Object.entries(cost.byModel)
    if (models.length > 0) {
      lines.push('')
      lines.push(accent('Per-model breakdown'))
      for (const [model, data] of models) {
        const row = data as { tokens: number; dollars: number }
        lines.push(
          `  ${muted(model.padEnd(24, ' '))}  ${value(formatTokenCount(row.tokens).padStart(8, ' '))} tok  ${value(`$${row.dollars.toFixed(4)}`)}`,
        )
      }
      if (models.length > 1) {
        lines.push(
          `  ${muted('total'.padEnd(24, ' '))}  ${value(formatTokenCount(snapshot.totalTokens).padStart(8, ' '))} tok  ${value(`$${cost.totalDollars.toFixed(4)}`)}`,
        )
      }
    }
  }

  // Token totals
  if (snapshot.totalTokens > 0) {
    lines.push('')
    lines.push(accent('Tokens'))
    lines.push(`  Total:  ${value(formatTokenCount(snapshot.totalTokens))}`)
    if (snapshot.turnTokens > 0) {
      lines.push(`  Last turn: ${value(formatTokenCount(snapshot.turnTokens))}`)
    }
  }

  const panel = new UsagePanelComponent(lines, colors.primary, ' Cost ')
  host.state.transcriptContainer.addChild(panel)
  host.state.ui.requestRender()
}
