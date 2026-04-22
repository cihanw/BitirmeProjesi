from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.endpoints import auth, upload, search, people, ai
from app.core.config import settings
import uvicorn

app = FastAPI(
    title="Smart Gallery Backend",
    description="Intelligence API for Semantic Search, Face Clustering, and Ephemeral Processing",
    version="1.0.0"
)

# Allow all origins for mobile app local development, can restrict in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(auth.router, prefix="/api", tags=["Auth"])
app.include_router(upload.router, prefix="/api", tags=["Upload"])
app.include_router(search.router, prefix="/api", tags=["Search"])
app.include_router(people.router, prefix="/api", tags=["People"])
app.include_router(ai.router,     prefix="/api", tags=["AI"])

@app.get("/health")
def health_check():
    return {
        "status": "online",
        "supabase_configured": bool(settings and settings.SUPABASE_URL),
        "qdrant_configured": bool(settings and settings.QDRANT_HOST),
        "gemini_configured": bool(settings and settings.GEMINI_API_KEY),
        "dev_bypass_auth": bool(settings and settings.DEV_BYPASS_AUTH),
    }

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
