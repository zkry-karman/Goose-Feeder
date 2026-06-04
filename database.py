from sqlalchemy import create_engine, Column, Integer, String, Boolean
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from passlib.context import CryptContext

DATABASE_URL = "sqlite:///./cat_dashboard.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    token_balance = Column(Integer, default=3)

class BlogPost(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True, index=True)
    tite = Column(String)
    content = Column(String)
    date = Column(String)
    image_url = Column(String, nullable=True)
    author_id = Column(Integer)

def init_db():
    Base.metadata.create_all(bind=engine)