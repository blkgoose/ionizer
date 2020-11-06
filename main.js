data = {}
ship = undefined

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)
  frameRate(5)

  runBackground(updateShip, 100)
  runBackground(updateRadar, 1000)
}

function draw() {
  document.title=frameRate()

  clear()
  ambientLight(255, 255, 255)

  for (key in data) {
    let entity = data[key]
    drawEntity(entity.body, entity.hasOwnProperty("mineable") ? "ROCK" : "SHIP", 50)
  }

  if (ship) {
    camera(ship.body.position[0], ship.body.position[1], ship.body.position[2] - 1000, ship.body.position[0], ship.body.position[1], ship.body.position[2], 0, 50, 0)
    drawEntity(ship.body, "SHIP", 50)
  }
}

const updateRadar = () => {
  fetch("http://localhost:3000/1f9c75b0-6edc-36a4-a15b-279b8b531ca8/controller/action",
    { method: "POST"
    , headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    , body: encodeJson({ username:  "username"
                       , password:  "password"
                       , component: "radar"
                       , action:    "scan"
                       })
    })
    .then(r => r.json())
    .then(r => r.forEach(e => data[e[0]] = e[1]))
}

const updateShip = () => {
  fetch("http://localhost:3000/1f9c75b0-6edc-36a4-a15b-279b8b531ca8/controller/info",
    { method: "POST"
    , headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    , body: encodeJson({ username: "username"
                       , password: "password"
                       })
    })
    .then(r => r.json())
    .then(e => ship = e)
}

const drawEntity = (body, type, size) => {
  push()
  translate(body.position[0], body.position[1], body.position[2])
  switch(type) {
    case "SHIP": ambientMaterial(255, 0, 0)
      break
    case "ROCK": ambientMaterial(25, 25, 25);
      break
  }
  sphere(size)
  pop()
}

const encodeJson = (obj) => {
  var str = []
  for (var key in obj)
    if (obj.hasOwnProperty(key))
      str.push(encodeURIComponent(key) + "=" + encodeURIComponent(obj[key]))

  return str.join("&")
}

const runBackground = (f, timeout=0) => {
  setTimeout(() => {
    f()
    runBackground(f, timeout)
  }, timeout)
}
