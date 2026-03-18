/**
 * Built-in line diff — no npm deps required.
 * Uses Myers diff algorithm (simplified).
 */
'use strict';

function diffLines(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Build LCS table
  const m = oldLines.length, n = newLines.length;
  const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
  for (let i=m-1;i>=0;i--) for (let j=n-1;j>=0;j--)
    dp[i][j] = oldLines[i]===newLines[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j],dp[i][j+1]);

  // Trace back
  const result = [];
  let i=0,j=0;
  while (i<m||j<n) {
    if (i<m&&j<n&&oldLines[i]===newLines[j]) { result.push({type:'context',content:oldLines[i],oldLine:i+1,newLine:j+1}); i++;j++; }
    else if (j<n&&(i>=m||dp[i+1]?.[j]<dp[i]?.[j+1])) { result.push({type:'add',content:newLines[j],oldLine:null,newLine:j+1}); j++; }
    else { result.push({type:'remove',content:oldLines[i],oldLine:i+1,newLine:null}); i++; }
  }
  return result;
}

function structuredPatch(oldText, newText, filename='') {
  const allLines = diffLines(oldText, newText);
  const CONTEXT = 3;

  // Group into hunks
  const changed = allLines.map((l,i)=>({...l,idx:i})).filter(l=>l.type!=='context');
  if (!changed.length) return {filename, hunks:[], stats:{added:0,removed:0,hunks:0}};

  const hunks = [];
  let i=0;
  while (i<changed.length) {
    let start = Math.max(0, changed[i].idx - CONTEXT);
    let end = changed[i].idx + CONTEXT;
    while (i+1<changed.length && changed[i+1].idx <= end+CONTEXT) { i++; end = changed[i].idx+CONTEXT; }
    end = Math.min(allLines.length-1, end);

    const lines = allLines.slice(start, end+1);
    const oldStart = (lines.find(l=>l.oldLine)?.oldLine||1);
    const newStart = (lines.find(l=>l.newLine)?.newLine||1);
    hunks.push({ oldStart, newStart, oldLines: lines.filter(l=>l.type!=='add').length, newLines: lines.filter(l=>l.type!=='remove').length, lines });
    i++;
  }

  const stats = { added: allLines.filter(l=>l.type==='add').length, removed: allLines.filter(l=>l.type==='remove').length, hunks: hunks.length };
  return { filename, hunks, stats };
}

module.exports = { structuredPatch, diffLines };
