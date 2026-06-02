from fastapi import FastAPI
from fastapi.responses import HTMLResponse
import asyncio

app = FastAPI()

motor_is_busy = False

@app.get("/", response_class=HTMLResponse)
def home():
        with open("index.html", "r") as file:
                return file.read()

@app.get("/dispense")
async def dispense_treat():
        global motor_is_busy

        if motor_is_busy:
                return {"status": "Error", "message": "Motor is busy dispensing right meow"}
        
        motor_is_busy = True
        print("Motor started spinning...")

        await asyncio.sleep(3)

        motor_is_busy = False
        print("Motor finished spinning. Treat dropped!")

        return {"status": "Success", "message": "the motor spun and a treat was dropped!"}