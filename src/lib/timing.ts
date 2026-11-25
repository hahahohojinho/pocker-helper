/** Runs async work and reports how long it took, for solve timing outside React render code. */
export async function timed<T>(work:()=>Promise<T>){
  const started=performance.now();
  const value=await work();
  return {value,elapsedMs:performance.now()-started};
}
