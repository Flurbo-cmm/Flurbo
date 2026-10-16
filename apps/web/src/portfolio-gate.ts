// The portfolio shows its page at once when this browser already has holdings or history for the account.
// Only a first ever load, with nothing saved and no read finished or failed, waits behind the loading cover.
export function portfolioGatePending({ busy, rowCount, saved, anyDone }: { busy: boolean; rowCount: number; saved: boolean; anyDone: boolean }) {
  return busy && rowCount === 0 && !saved && !anyDone;
}
