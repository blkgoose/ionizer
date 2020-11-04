function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)
  frameRate(5)
}

accelerating=false
mouseStartingPositionY=0
prevMouseY=0
prevActivation=0

function draw() {
  document.title=frameRate()

  fetch("http://localhost:3000/info/1f9c75b0-6edc-36a4-a15b-279b8b531ca8")
    .then(r => r.json())
    .then(r => {
      prevActivation=r.thruster.activation

      clear()
      ambientLight(255, 255, 255)
      translate(r.body.position[0], r.body.position[1], r.body.position[2])
      push()
      ambientMaterial(255, 0, 0);
      sphere(50)
      pop()
    })

  if(keyIsPressed && key=='a' && !accelerating) {
    accelerating=true
    mouseStartingPositionY=mouseY
    prevMouseY=mouseY
  }
  if(!keyIsPressed){
    accelerating=false
  }
  if(accelerating && prevMouseY!=mouseY) {
    console.log("activation: ", JSON.stringify({activation: prevActivation+((mouseStartingPositionY-mouseY)*.1)}))

    fetch("http://localhost:3000/command/1f9c75b0-6edc-36a4-a15b-279b8b531ca8/thruster",
      { method: "POST"
      , headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      , body: "activation=10"
      }
    )

    prevMouseY=mouseY
  }
}

