const toggle = document.getElementById('advancedToggle');
const panel = document.getElementById('advancedPanel');
const collapse = document.querySelector('.collapse');
const startBtn = document.getElementById('startBtn');
const audioWave = document.querySelector('.wave');
audioWave.classList.add('idle');

function scrollAdvanced(){
  panel.scrollIntoView({behavior:'smooth', block:'start'});
  panel.animate([{transform:'scale(.985)'},{transform:'scale(1)'}],{duration:250,easing:'ease-out'});
}
toggle.addEventListener('click', scrollAdvanced);
toggle.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' ') scrollAdvanced(); });
collapse.addEventListener('click', () => document.querySelector('.popup').scrollIntoView({behavior:'smooth'}));

let running=false;
startBtn.addEventListener('click', () => {
  running = !running;
  startBtn.innerHTML = running ? '<span>■</span><span>Stop Captions</span>' : '<span class="play">▶</span><span>Start Captions</span>';
  startBtn.style.background = running ? 'linear-gradient(135deg,#ff6f6f,#d94f4f)' : 'linear-gradient(135deg,#48e894,#24bf6e)';
  audioWave.classList.toggle('live', running);
  audioWave.classList.toggle('idle', !running);
  audioWave.style.setProperty('--wave-level', running ? '.72' : '.18');
});
