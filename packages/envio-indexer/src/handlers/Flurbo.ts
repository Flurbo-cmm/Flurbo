import { indexer } from 'envio';

const id = (event: { srcAddress: string; block: { number: number }; logIndex: number }) => `${event.srcAddress}-${event.block.number}-${event.logIndex}`;

indexer.onEvent({ contract: 'PilotPool', event: 'Traded' }, async ({ event, context }) => {
  const poolId = event.srcAddress;
  const trader = event.params.trader;
  const amount = event.params.collateralAmount;
  const isBuy = event.params.isBuy;
  const pool = await context.Pool.getOrCreate({ id: poolId, tradeCount: 0, volumeAtoms: 0n, redeemedAtoms: 0n });
  const positionId = `${trader}-${poolId}`;
  const position = await context.TraderPosition.getOrCreate({ id: positionId, pool: poolId, trader,
    totalCostAtoms: 0n, totalProceedsAtoms: 0n, totalRedeemedAtoms: 0n, netCashflowAtoms: 0n, tradeCount: 0 });
  context.Pool.set({ ...pool, tradeCount: pool.tradeCount + 1, volumeAtoms: pool.volumeAtoms + amount });
  context.TraderPosition.set({ ...position, totalCostAtoms: position.totalCostAtoms + (isBuy ? amount : 0n),
    totalProceedsAtoms: position.totalProceedsAtoms + (isBuy ? 0n : amount),
    netCashflowAtoms: position.netCashflowAtoms + (isBuy ? -amount : amount), tradeCount: position.tradeCount + 1 });
  context.Trade.set({ id: id(event), pool: poolId, trader, side: isBuy ? 'BUY' : 'SELL', scope: Number(event.params.scope),
    mask: event.params.mask, quantityAtoms: event.params.quantity, amountAtoms: amount,
    blockNumber: event.block.number, timestamp: event.block.timestamp });
});

indexer.onEvent({ contract: 'PilotPool', event: 'Redeemed' }, async ({ event, context }) => {
  const poolId = event.srcAddress;
  const trader = event.params.owner;
  const amount = event.params.collateralAmount;
  const pool = await context.Pool.getOrCreate({ id: poolId, tradeCount: 0, volumeAtoms: 0n, redeemedAtoms: 0n });
  const positionId = `${trader}-${poolId}`;
  const position = await context.TraderPosition.getOrCreate({ id: positionId, pool: poolId, trader,
    totalCostAtoms: 0n, totalProceedsAtoms: 0n, totalRedeemedAtoms: 0n, netCashflowAtoms: 0n, tradeCount: 0 });
  context.Pool.set({ ...pool, redeemedAtoms: pool.redeemedAtoms + amount });
  context.TraderPosition.set({ ...position, totalRedeemedAtoms: position.totalRedeemedAtoms + amount,
    netCashflowAtoms: position.netCashflowAtoms + amount });
  context.Trade.set({ id: id(event), pool: poolId, trader, side: 'REDEEM', scope: Number(event.params.scope),
    mask: event.params.mask, quantityAtoms: event.params.quantity, amountAtoms: amount,
    blockNumber: event.block.number, timestamp: event.block.timestamp });
});

indexer.onEvent({ contract: 'PilotResolver', event: 'Asserted' }, async ({ event, context }) => {
  context.ResolutionEvent.set({ id: id(event), resolver: event.srcAddress, eventIndex: Number(event.params.eventIndex),
    phase: 'Asserted', outcome: Number(event.params.outcome), blockNumber: event.block.number, timestamp: event.block.timestamp });
});
indexer.onEvent({ contract: 'PilotResolver', event: 'Disputed' }, async ({ event, context }) => {
  context.ResolutionEvent.set({ id: id(event), resolver: event.srcAddress, eventIndex: Number(event.params.eventIndex),
    phase: 'Disputed', outcome: Number(event.params.outcome), blockNumber: event.block.number, timestamp: event.block.timestamp });
});
indexer.onEvent({ contract: 'PilotResolver', event: 'Finalized' }, async ({ event, context }) => {
  context.ResolutionEvent.set({ id: id(event), resolver: event.srcAddress, eventIndex: Number(event.params.eventIndex),
    phase: 'Finalized', outcome: Number(event.params.outcome), blockNumber: event.block.number, timestamp: event.block.timestamp });
});
indexer.onEvent({ contract: 'PilotResolver', event: 'Delivered' }, async ({ event, context }) => {
  context.ResolutionEvent.set({ id: id(event), resolver: event.srcAddress, eventIndex: undefined,
    phase: 'Delivered', outcome: undefined, blockNumber: event.block.number, timestamp: event.block.timestamp });
});
