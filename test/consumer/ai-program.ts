import { createEnvironment, createProgramRunner, readProgramAnswer } from '@jarenjs/ai';
import type { ProgramRunResult, ProgramAnswer, ProgramStepReport } from '@jarenjs/ai';
import type { ProgramRunResult as SubpathResult } from '@jarenjs/ai/program';

const environment = createEnvironment();
const result: ProgramRunResult = await createProgramRunner({ environment }).run({ steps: [] });
const same: SubpathResult = result;
const count: number = result.subcalls;
// @ts-expect-error runner results must not degrade to any
const badCount: string = result.subcalls;
// @ts-expect-error unknown fields are not a public result contract
result.imaginary;
if (result.ok) {
  const answer: ProgramAnswer = result.answer;
  const truncated: boolean = answer.truncated;
  const full = await readProgramAnswer(environment, answer, { maxChars: 10000 });
  if (full.ok) {
    const text: string = full.answer.text;
    void text;
  }
  void truncated;
} else {
  const answer: null = result.answer;
  const error: string = result.error;
  void [answer, error];
}
for (const step of result.steps) {
  const report: ProgramStepReport = step;
  if (report.op === 'map') {
    const failed: number = report.failed;
    void failed;
  }
}
void [same, count, badCount];
