export const TILE_H=124,TILE_H_COMPACT=68,TILE_MIN_W=272,BOARD_GAP=12,COMPACT_GAP=8,MIN_BOARD_HEIGHT=560;

// How many tiles fit the board area without page scrolling. `chrome` is everything above and below the grid,
// measured from the page; `width` is the grid width.
export function boardCapacity({width,height,compact,chrome,tileH=compact?TILE_H_COMPACT:TILE_H,tileMinW=TILE_MIN_W,gap=compact?COMPACT_GAP:BOARD_GAP}:{width:number;height:number;compact:boolean;chrome:number;tileH?:number;tileMinW?:number;gap?:number}){
  const available=height-chrome;
  const columns=compact?1:Math.max(1,Math.floor((width+gap)/(tileMinW+gap)));
  const rows=Math.max(0,Math.floor((available+gap)/(tileH+gap)));
  return {columns,rows,perPage:columns*rows,fits:rows>=2&&height>=MIN_BOARD_HEIGHT};
}

export function paginate<T>(items:T[],perPage:number,page:number){
  if(!(perPage>0))return {items,page:1,pageCount:1};
  const pageCount=Math.max(1,Math.ceil(items.length/perPage));
  const current=Math.min(pageCount,Math.max(1,Number.isFinite(page)?Math.floor(page):1));
  return {items:items.slice((current-1)*perPage,current*perPage),page:current,pageCount};
}
