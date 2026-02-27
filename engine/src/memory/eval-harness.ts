import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousMemory } from './autonomous-memory.js';
import { MemoryAutomationService } from './memory-automation-service.js';
import { BrowserAgentStore } from '../session/store.js';
import type { BrowserCommand } from '../protocol/commands.js';

interface EvalIntent {
  readonly label: string;
  readonly command: BrowserCommand;
  readonly hostUrl: string;
}

interface TrainingOutcome {
  readonly command: BrowserCommand;
  readonly hostUrl: string;
  readonly success: boolean;
}

function makeDbPath(): string {
  return path.join(
    os.tmpdir(),
    `browser-agent-memory-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

function run(): void {
  const dbPath = makeDbPath();
  const store = new BrowserAgentStore(dbPath);
  const memory = new MemoryAutomationService(store);
  const autonomous = new AutonomousMemory(store);
  const sessionId = 'eval-session';

  try {
    memory.setNoStore(false);

    memory.capturePrompt({
      sessionId,
      source: 'cli',
      role: 'user',
      content: 'I prefer zero-downtime deploys. [MEMORY_CHECKPOINT]Always validate production domain before save.[/MEMORY_CHECKPOINT]',
    });
    memory.capturePrompt({
      sessionId,
      source: 'extension',
      role: 'assistant',
      content: '[USER_ACTION_REQUIRED]Sign in on Vercel and confirm 2FA.[/USER_ACTION_REQUIRED]',
    });

    const training: readonly TrainingOutcome[] = [
      {
        command: { type: 'click', selector: 'button[data-testid="save-settings"]' },
        hostUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
        success: true,
      },
      {
        command: { type: 'click', selector: 'button[data-testid="save-settings"]' },
        hostUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
        success: true,
      },
      {
        command: { type: 'click', selector: 'button[data-testid="danger-delete"]' },
        hostUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
        success: false,
      },
      {
        command: { type: 'select', selector: 'select[name="framework"]', value: 'nextjs' },
        hostUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
        success: true,
      },
      {
        command: { type: 'select', selector: 'select[name="framework"]', value: 'nextjs' },
        hostUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
        success: true,
      },
      {
        command: { type: 'evaluate', script: '() => localStorage.clear()' },
        hostUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
        success: false,
      },
    ];

    for (const item of training) {
      memory.captureCommandOutcome({
        sessionId,
        command: item.command,
        activeTabUrl: item.hostUrl,
        success: item.success,
        approvalSource: 'user_confirmation',
      });

      autonomous.recordCommandOutcome({
        command: item.command,
        activeTabUrl: item.hostUrl,
        success: item.success,
        approvalSource: 'user_confirmation',
      });
    }

    const intents: readonly EvalIntent[] = [
      {
        label: 'GitHub save click',
        command: { type: 'click', selector: 'button[data-testid="save-settings"]' },
        hostUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      },
      {
        label: 'GitHub dangerous click',
        command: { type: 'click', selector: 'button[data-testid="danger-delete"]' },
        hostUrl: 'https://github.com/CMZCoder/BrowserAgent/settings',
      },
      {
        label: 'Vercel framework select',
        command: { type: 'select', selector: 'select[name="framework"]', value: 'nextjs' },
        hostUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
      },
      {
        label: 'Vercel evaluate script',
        command: { type: 'evaluate', script: '() => localStorage.clear()' },
        hostUrl: 'https://vercel.com/cmzcoder/comerzio/settings',
      },
    ];

    const allCards = store.listMemoryCards({ limit: 500, status: 'active' });

    const precisionScores: number[] = [];
    const recallScores: number[] = [];
    let wrongMemoryHits = 0;
    let totalRetrieved = 0;

    for (const intent of intents) {
      const host = new URL(intent.hostUrl).hostname.toLowerCase();
      const retrieved = memory.retrieveForCommandIntent({
        sessionId,
        command: intent.command,
        activeTabUrl: intent.hostUrl,
        limit: 5,
      });

      const relevantRetrieved = retrieved.filter((card) => {
        const domainMatch = card.domain === null || card.domain === host;
        const intentMatch = typeof card.intentKey === 'string' ? card.intentKey.includes(intent.command.type) : true;
        return domainMatch && intentMatch;
      });

      const relevantCorpus = allCards.filter((card) => {
        const domainMatch = card.domain === null || card.domain === host;
        const intentMatch = typeof card.intentKey === 'string' ? card.intentKey.includes(intent.command.type) : true;
        return card.status === 'active' && domainMatch && intentMatch;
      });

      precisionScores.push(relevantRetrieved.length / Math.max(1, retrieved.length));
      recallScores.push(relevantRetrieved.length / Math.max(1, relevantCorpus.length));

      for (const card of retrieved) {
        if (card.domain !== null && card.domain !== host) {
          wrongMemoryHits += 1;
        }
      }
      totalRetrieved += retrieved.length;
    }

    const baselinePredictedSuccess = intents.map(() => 0.5);
    const learnedPredictedSuccess = intents.map((intent) => {
      const host = new URL(intent.hostUrl).hostname.toLowerCase();
      const cards = memory.retrieveForCommandIntent({
        sessionId,
        command: intent.command,
        activeTabUrl: intent.hostUrl,
        limit: 4,
      });
      const policy = cards.find((card) => card.scope === 'policy' && (card.domain === null || card.domain === host));
      return policy ? Math.max(0.1, Math.min(0.95, policy.reliability)) : 0.5;
    });

    const baselineSuccessRate = mean(baselinePredictedSuccess);
    const learnedSuccessRate = mean(learnedPredictedSuccess);
    const actionSuccessUplift = baselineSuccessRate > 0
      ? ((learnedSuccessRate - baselineSuccessRate) / baselineSuccessRate) * 100
      : 0;

    const mutatingIntents = intents.filter((intent) =>
      intent.command.type === 'click' ||
      intent.command.type === 'select' ||
      intent.command.type === 'type' ||
      intent.command.type === 'auth_fill_secret' ||
      intent.command.type === 'evaluate',
    );

    let learnedInterrupts = 0;
    for (const intent of mutatingIntents) {
      const policyDecision = memory.evaluateCommandPolicy({
        sessionId,
        command: intent.command,
        activeTabUrl: intent.hostUrl,
        confirmationProvided: false,
      });

      if (policyDecision.blocked) {
        learnedInterrupts += 1;
        continue;
      }

      const auto = autonomous.tryAutoApprove(intent.command, intent.hostUrl);
      if (!auto.approved) {
        learnedInterrupts += 1;
      }
    }

    const baselineInterrupts = mutatingIntents.length;
    const userInterruptReduction = baselineInterrupts > 0
      ? ((baselineInterrupts - learnedInterrupts) / baselineInterrupts) * 100
      : 0;

    const report = {
      generatedAt: new Date().toISOString(),
      metrics: {
        retrievalPrecisionProxy: Number(mean(precisionScores).toFixed(4)),
        retrievalRecallProxy: Number(mean(recallScores).toFixed(4)),
        wrongMemoryRate: Number((wrongMemoryHits / Math.max(1, totalRetrieved)).toFixed(4)),
        actionSuccessUpliftPct: Number(actionSuccessUplift.toFixed(2)),
        userInterruptReductionPct: Number(userInterruptReduction.toFixed(2)),
      },
      sampleSizes: {
        intents: intents.length,
        mutatingIntents: mutatingIntents.length,
        memoryCards: allCards.length,
      },
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    store.close();
    try {
      fs.rmSync(dbPath, { force: true });
    } catch {
      // ignore cleanup failure for local eval harness
    }
  }
}

run();
