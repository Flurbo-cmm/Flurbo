// Keyboard shortcuts move focus and choose options. None of them confirms, approves or sends anything.
export const SHORTCUT_ACTIONS=['search','next','prev','open','yes','no','pageNext','pagePrev','watch','help','buy','sell','refresh'] as const;
export type ShortcutAction=typeof SHORTCUT_ACTIONS[number];
type Target={tagName?:string;isContentEditable?:boolean}|null;

const BOARD:Record<string,ShortcutAction>={'/':'search',j:'next',k:'prev',Enter:'open',y:'yes',n:'no',']':'pageNext',PageDown:'pageNext','[':'pagePrev',PageUp:'pagePrev',w:'watch'};
const MARKET:Record<string,ShortcutAction>={y:'yes',n:'no',b:'buy',s:'sell',r:'refresh'};

export const SHORTCUT_HELP:{scope:'board'|'market';keys:string[];label:string}[]=[
  {scope:'board',keys:['/'],label:'Search markets'},
  {scope:'board',keys:['j','k'],label:'Next or previous market'},
  {scope:'board',keys:['Enter'],label:'Open the selected market'},
  {scope:'board',keys:['y','n'],label:'Open the selected market with Yes or No chosen'},
  {scope:'board',keys:['[',']'],label:'Previous or next page'},
  {scope:'board',keys:['w'],label:'Add or remove from watchlist'},
  {scope:'market',keys:['y','n'],label:'Choose Yes or No'},
  {scope:'market',keys:['b','s'],label:'Buy or sell'},
  {scope:'market',keys:['r'],label:'Refresh the price'},
];

export function shortcutFor(event:{key:string;ctrlKey:boolean;metaKey:boolean;altKey:boolean;shiftKey:boolean},target:Target,scope:'board'|'market',dialogOpen:boolean):ShortcutAction|null{
  if(dialogOpen||event.ctrlKey||event.metaKey||event.altKey)return null;
  const tag=target?.tagName?.toUpperCase();
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||target?.isContentEditable)return null;
  if(event.key==='?')return 'help';
  if(event.shiftKey)return null;
  return (scope==='board'?BOARD:MARKET)[event.key]??null;
}
