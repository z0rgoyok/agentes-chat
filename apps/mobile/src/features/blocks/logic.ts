/*
 * Live blocks on the phone (ADR 0113). Pure, so it is unit-tested. The web view itself is the sandbox here, as for any
 * native host of pages like these: nothing of the app is in it to reach, and these are the rules that keep it so.
 */

/** Frames kept running at once: each is a browser of its own in memory, and the rest wait for a tap. */
export const MAX_LIVE_BLOCKS = 3;

/** Preview cap for a long block in the conversation. */
export const INLINE_HEIGHT = 380;

/** Leave room for the loading indicator or the tap to wake a suspended page. */
export function inlineBlockHeight(height: number, open: boolean): number {
  const measured = Math.max(44, height);
  return open ? measured : Math.min(measured, INLINE_HEIGHT);
}

/**
 * A web view for what an agent writes (a block, a page; ADR 0019): its page loads and nothing else does, and it gets
 * no cookies, storage, files, windows, location or camera of the phone's. With `isolatedPage`'s policy inside it,
 * it is cut off from the network too.
 */
export const ISOLATED_WEB_VIEW = {
  // Every address passes this list and is refused by `onShouldStartLoadWithRequest`: one failed here would go to the
  // system to open.
  originWhitelist: ["*"],
  onShouldStartLoadWithRequest: (request: { url: string }) => blockMayLoad(request.url),
  javaScriptEnabled: true,
  javaScriptCanOpenWindowsAutomatically: false,
  setSupportMultipleWindows: false,
  domStorageEnabled: false,
  incognito: true,
  cacheEnabled: false,
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  geolocationEnabled: false,
  mediaCapturePermissionGrantType: "deny" as const,
  mediaPlaybackRequiresUserAction: true,
};

/**
 * Run first in a page this web view shows (a script for its `<head>`, as the web's page frame runs its own): in-memory
 * stand-ins for `localStorage`, `sessionStorage` and `document.cookie`. With no storage of its own
 * (`ISOLATED_WEB_VIEW`), a page that touches them threw before drawing anything. What the page does after it stays as
 * it wrote it.
 */
export const STORAGE_STANDINS = `<script>(function(){
function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){var k=Object.keys(d)[i];return k===undefined?null:k},get length(){return Object.keys(d).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{void window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{void document.cookie}catch(e){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}}
})();</script>`;

/**
 * Where a block may go: nowhere. Its page is the first load. Anything else would be how a page sends out what it
 * holds, so it is refused here and never handed to the system to open.
 */
export function blockMayLoad(url: string) {
  return url === "about:blank" || url === "about:srcdoc";
}

/** What the app says to the page already running: a theme change, or everyone's state when it moved. */
export const hostScript = (message: object) =>
  `window.__agentesHost&&window.__agentesHost(${JSON.stringify(message)});true;`;

export const themeScript = (theme: "light" | "dark") => hostScript({ theme });

/**
 * The frames allowed to run, newest in. Whoever asks last gets a place, and the oldest one past the limit gives it
 * up: a long conversation never holds more than `MAX_LIVE_BLOCKS` browsers.
 */
export function withLiveBlock(live: readonly string[], key: string, max = MAX_LIVE_BLOCKS): string[] {
  return [...live.filter((k) => k !== key), key].slice(-max);
}

/**
 * How far a vote's voter tucks under the one before, as the web's stack (`.ac-avatar-stack`): 6 points past a photo,
 * and past initials only the 2-point rings over each other, so no letter is covered.
 */
export const faceOverlap = (afterPhoto: boolean) => ({ marginLeft: afterPhoto ? -6 : -4 });
