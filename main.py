from fastapi import FastAPI, Form, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from contextlib import asynccontextmanager
import asyncio
import secrets
from fastapi import Response, responses, Cookie
from database import init_db, SessionLocal, User, pwd_context, SessionToken

@asynccontextmanager
async def lifespan(app: FastAPI):
        init_db()
        print("Database initialized successfully via Lifespan!")
        yield
        print("Server is shutting down cleanly...")

app = FastAPI(lifespan=lifespan)

def get_db():
        db = SessionLocal()
        try:
                yield db
        finally:
                db.close()

def get_current_user(db: Session, session_cookie: str = Cookie(None)):
        if not session_cookie:
                return None
        session_record = db.query(SessionToken).filter(SessionToken.token == session_cookie).first()
        if not session_record:
                return None
        return db.query(User).filter(User.id == session_record.user_id).first()

@app.post("/login")
async def login_user(
        username: str = Form(...),
        password: str = Form(...),
        db: Session = Depends(get_db)
):
        user = db.query(User).filter(User.username == username).first()
        if not user:
                raise HTTPException(status_code=400, detail="Invalid username or password")
        if not pwd_context.verify(password, user.hashed_password):
                raise HTTPException(status_code=400, detail="Invalid username or password")
        
        random_token = secrets.token_hex(32)
        new_session = SessionToken(token=random_token, user_id=user.id)
        db.add(new_session)
        db.commit()

        redirect_response = responses.RedirectResponse(url="/", status_code=303)

        redirect_response.set_cookie(key="session_cookie", value=random_token, httponly=True)
        print(f"User logged in successfully: {username}")
        return redirect_response

@app.get("/logout")
async def logout_user(
        session_cookie: str = Cookie(None),
        db: Session = Depends(get_db)
):
        if session_cookie:
                db.query(SessionToken).filter(SessionToken.token == session_cookie).delete()
                db.commit()

        redirect_response = RedirectResponse(url="/", status_code=303)
        redirect_response.delete_cookie(key="session_cookie")
        return RedirectResponse(url="/", status_code=303)


@app.post("/register")
async def register_user(
        username: str = Form(...),
        email: str = Form(...),
        password: str = Form(...),
        db: Session = Depends(get_db)
):
        existing_user = db.query(User).filter(User.username == username).first()
        if existing_user:
                raise HTTPException(status_code=400, detail="Username already registered")
        try:
                hashed_pass = pwd_context.hash(password)
        except ValueError as e:
                print(f"Bcrypt Error Debug: {e}")
                raise HTTPException(status_code=400, detail="Password structure issue.")
        new_user = User(
                username = username,
                email = email,
                hashed_password = hashed_pass,
                token_balance = 20
        )
        db.add(new_user)
        db.commit()
        db.refresh(new_user)

        print(f"New user created: {username} with 3 tokens!")

        return RedirectResponse(url="/", status_code=303)

motor_is_busy = False

@app.get("/", response_class=HTMLResponse)
def home(db: Session = Depends(get_db), session_cookie: str = Cookie(None)):
        with open("index.html", "r") as file:
                html_content = file.read()

        user = get_current_user(db, session_cookie)
        
        if user:
                user_panel = f"""
                <span style="color: white; font-weight: bold; margin-right: 15px;">👋 {user.username} (🐟 {user.token_balance} Tokens)</span>
                <a href="/logout" class="btn btn-sm" style="background-color: #ff4757; text-decoration: none; color: white;">Logout</a>
                """
        else:
                user_panel = """
                <button class="btn btn-sm" style="background-color: transparent; border: 2px solid white; color: white;" onclick="openLogin()">Sign In</button>
                <button class="btn btn-sm" style="background-color: white; color: black;" onclick="openRegister()">Join</button>
                """

        customized_html = html_content.replace("REPLACE_ME", user_panel)
        return customized_html

@app.get("/dispense")
async def dispense_treat(db: Session = Depends(get_db), session_cookie: str = Cookie(None)):
        global motor_is_busy

        user = get_current_user(db, session_cookie)
        if not user:
                return {"Status": "Error", "message": "You must be logged in to feed Goose !"}
        
        if user.token_balance <= 0:
                return {"Status": "Error", "message": "Out of tokens ! Please buy more to continue feeding Goose."}

        if motor_is_busy:
                return {"status": "Error", "message": "Motor is busy dispensing right meow"}
        
        user.token_balance -= 1
        db.commit()
        motor_is_busy = True
        print("Motor started spinning...")

        await asyncio.sleep(3)

        motor_is_busy = False
        print("Motor finished spinning. Treat dropped!")

        return {"status": "Success", "message": "the motor spun and a treat was dropped!"}