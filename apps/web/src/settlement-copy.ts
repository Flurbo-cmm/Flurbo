// What the Timeline says while a Reality question waits for its first answer.
export function awaitingAnswer({ automatic, opensAt, now, reportDeadline, format }:
  { automatic: boolean; opensAt: number; now: number; reportDeadline: number; format: (seconds: number) => string }): { meta: string; caption: string } {
  const open = now >= opensAt;
  const meta = automatic
    ? open ? "Flurbo's reader is posting the first answer" : `Flurbo's reader answers after ${format(opensAt)}`
    : open ? 'No automatic reader: anyone can post the first answer with a Sepolia ETH bond' : `Anyone can answer after ${format(opensAt)}`;
  return { meta, caption: `If nobody answers by ${format(reportDeadline)}, this question settles Void.` };
}
