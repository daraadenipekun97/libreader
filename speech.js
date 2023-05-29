// import EasySpeech from './EasySpeech.js'

document.body.onload = async () => {
  createLog()
  appendFeatures(EasySpeech.detect())
  const initialized = await init()
  await populateVoices(initialized)
  initInputs(initialized)
  await initSpeak(initialized)
  initEvents(initialized)
}



let logBody
let filteredVoices

const values = {
  voice: undefined,
  rate: undefined,
  pitch: undefined,
  volume: undefined,
  text: undefined
}

const inputs = {
  volume: undefined,
  rate: undefined,
  pitch: undefined,
  text:undefined, 
  language: undefined,
  voice: undefined
}

function initInputs (initialized) {
  if (!initialized) return

  const volumeValue = document.querySelector('.volume-value')
  inputs.volume = document.querySelector('#volume-input')
  inputs.volume.disabled = false
  inputs.volume.addEventListener('change', e => {
    values.volume = e.target.value / 100
    volumeValue.removeChild(volumeValue.firstChild)
    volumeValue.appendChild(document.createTextNode(values.volume))
  })

  const rateValue = document.querySelector('.rate-value')
  inputs.rate = document.querySelector('#rate-input')
  inputs.rate.disabled = false
  inputs.rate.addEventListener('change', e => {
    values.rate = e.target.value / 10
    rateValue.removeChild(rateValue.firstChild)
    rateValue.appendChild(document.createTextNode(values.rate))
  })

  const pitchValue = document.querySelector('.pitch-value')
  inputs.pitch = document.querySelector('#pitch-input')
  inputs.pitch.disabled = false
  inputs.pitch.addEventListener('change', e => {
    values.pitch = e.target.value
    pitchValue.removeChild(pitchValue.firstChild)
    pitchValue.appendChild(document.createTextNode(values.pitch))
  })

  inputs.text = document.querySelector('#text-input')
 inputs.text.disabled = false
}

function getValues () {
  return { ...values }
}

function createLog () {
//   logBody = document.querySelector('.log-body')
  EasySpeech.debug(debug)
}

function debug (arg) {
//   logBody.appendChild(textNode(arg))
  console.log(arg)
}

async function init () {
  const header = document.querySelector('.init-status-header')
//   const body = document.querySelector('.init-status-body')
  header.classList.add('info')

  let success
  let message
  try {
    success = await EasySpeech.init()
    message = 'Successfully intialized 🎉'
  } catch (e) {
    success = false
    message = e.message
  } finally {
    const bg = success
      ? 'success'
      : 'danger'

    header.classList.remove('info')
    header.classList.add(bg)
    // body.appendChild(textNode(message))
    console.log(message)
  }

  return success
}

async function populateVoices (initialized) {
  if (!initialized) return

  debug('find unique languages...')
  const voices = EasySpeech.voices()
  const languages = new Set()
  // console.log(voices)
  voices.forEach(voice => {
    languages.add(voice.lang.split(/[-_]/)[0])
  })

  debug(`found ${languages.size} languages`)
  debug('populate languages to select component')

  inputs.language = document.querySelector('#lang-select')
  Array.from(languages).sort().forEach(lang => {
    const option = textNode(lang, 'option')
    option.setAttribute('value', lang)
    inputs.language.appendChild(option)
  })

  debug('attach events, cleanup')
  inputs.voice = document.querySelector('#voice-select')

  inputs.language.addEventListener('change', e => {
    while (inputs.voice.firstChild) {
      inputs.voice.removeChild(inputs.voice.lastChild)
    }
    inputs.voice.appendChild(textNode('(Select voice)', 'option'))

    const value = e.target.value

    if (!value) {
      inputs.voice.classList.add('disabled')
      inputs.voice.disabled = true
      values.voice = null
      filteredVoices = null
      return
    }

    filteredVoices = voices
      .filter(voice => {
        return voice.lang.indexOf(`${value}-`) > -1 || voice.lang.indexOf(`${value}_`) > -1
      })
      .sort((a, b) => a.name.localeCompare(b.name))

    filteredVoices.forEach((voice, index) => {
      const service = voice.localService ? 'local' : 'remote'
      const isDefault = voice.default ? '[DEFAULT]' : ''
      const voiceName = `${isDefault}${voice.name} - ${voice.voiceURI} (${service})`
      const option = textNode(voiceName, 'option')
      option.setAttribute('value', index.toString(10))
      inputs.voice.appendChild(option)
    })

    inputs.voice.classList.remove('disabled')
    inputs.voice.removeAttribute('disabled')
  })

  inputs.voice.addEventListener('change', e => {
    const value = Number.parseInt(e.target.value, 10)
    if (value < 0 || value > filteredVoices.length - 1) {
      values.voice = undefined
      return
    }

    values.voice = (filteredVoices || [])[value]
  })

  inputs.language.classList.remove('disabled')
  inputs.language.removeAttribute('disabled')
}


function initSpeak (inititalized) {
  if (!inititalized) return

  const speakButton = document.querySelector('.speak-btn');
  const stopButton = document.querySelector('.stop-btn');
  const pauseButton = document.querySelector('.pause-btn');
  const resumeButton = document.querySelector('.resume-btn');
  const textArea = document.querySelector('#text-input');
  const backBtn = document.querySelector('.open');
  const nextBtn = document.querySelector('.next');
  const allInputs = Object.values(inputs)

  speakButton.addEventListener('click', async event => {
    speakButton.disabled = true
    allInputs.forEach(input => {
      input.disabled = true
    })

    const { pitch, rate, voice, volume } = getValues()
    const text = window.globalVariable.epubText;
    // console.log("here is text" + text)

    const highlight = (text, from, to) => {
        let replacement = highlightBackground(text.slice(from, to))
        return text.substring(0, from) + replacement + text.substring(to)
      }

      const highlightBackground = sample => `**${sample}**`


    try {
        await EasySpeech.speak({
            text,
            pitch,
            rate,
            voice,
            volume,
            boundary: event => {
                const { charIndex, charLength } = event;
                window.globalVariable.epubBodyTag.innerText =  highlight(text, charIndex, charIndex + charLength)
            },
            start: event => {
              nextBtn.addEventListener("click", handleClick);

              backBtn.addEventListener("click", handleClickBack);

              function handleClick(event) {
                if (event.isTrusted) {
                  stopButton.click();
                  // setTimeout(() => {
                  //   speakButton.click();
                  // }, 3000)
                } else {
                  // alert("Button clicked programmatically.");
                }
              }

              function handleClickBack() {

                stopButton.click();
                
              }

            },
            end: event => {
              if(event.elapsedTime){
                nextBtn.click()
                setTimeout(() => {
                  speakButton.click();
                }, 3000)
              }
            }
        
        })
    } catch (e) {
      debug(e.message)
    } finally {
      speakButton.disabled = false
      allInputs.forEach(input => {
        input.disabled = false
      })
    }
  })


  stopButton.addEventListener('click', async event => {
    stopButton.disabled = true
    allInputs.forEach(input => {
        input.disabled = true
      })
    try {
        await EasySpeech.cancel(); 
    } catch (e) {
        debug(e.message)        
    } finally {
        stopButton.disabled = false
        allInputs.forEach(input => {
          input.disabled = false
        })
      }
  })


  pauseButton.addEventListener('click', async event => {
    pauseButton.disabled = true
    allInputs.forEach(input => {
        input.disabled = true
      })
    try {
        await EasySpeech.pause(); 
    } catch (e) {
        debug(e.message)        
    } finally {
        pauseButton.disabled = false
        allInputs.forEach(input => {
          input.disabled = false
        })
      }
  })

  resumeButton.addEventListener('click', async event => {
    resumeButton.disabled = true
    allInputs.forEach(input => {
        input.disabled = true
      })
    try {
        await EasySpeech.resume(); 
    } catch (e) {
        debug(e.message)        
    } finally {
        resumeButton.disabled = false
        allInputs.forEach(input => {
          input.disabled = false
        })
      }
  })

}

function appendFeatures (detected) {
//   const featuresTarget = document.querySelector('.features')
  const features = {}

  Object.entries(detected).forEach(([key, value]) => {
    if (typeof value === 'object') {
      features[key] = value.toString()
    } else if (typeof value === 'function') {
      features[key] = value.name
    } else {
      features[key] = value
    }
  })

  

  const text = document.createTextNode(JSON.stringify(features, null, 2))
//   featuresTarget.appendChild(text)
console.log(JSON.stringify(features, null, 2))
}

function initEvents (initialized) {
  if (!initialized) return

  const logEvent = e => debug(`event: ${e.type}`)
  EasySpeech.on({
    boundary: logEvent,
    start: logEvent,
    end: logEvent,
    error: logEvent
  })
}

// HELPERS

const textNode = (text, parent = 'div') => {
  const entry = document.createElement(parent)
  entry.appendChild(document.createTextNode(text))
  return entry
}


