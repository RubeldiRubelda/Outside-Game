# Outside Game

A real-time, two-team photo checkpoint game.

## Features

*   **Real-time Admin Dashboard:** Monitor player progress, view photos, and manage the game state.
*   **Player UI:** Simple, mobile-first interface for joining games, receiving checkpoints, and uploading photos.
*   **Team-based Gameplay:** Two teams compete to complete checkpoints.
*   **Photo Uploads:** Players upload photos for each checkpoint.
*   **Session Persistence:** Players stay logged in even if they reload the page.
*   **Audio Alerts:** Get notified of important game events.
*   **QR Code Join:** Easily join a game by scanning a QR code.

## Installation

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Build the frontend:
    ```bash
    npm run build
    ```
4.  Start the server:
    ```bash
    npm run start
    ```

The application will be available at `http://localhost:7777`. The admin dashboard is at `http://localhost:7777/admin`.

## Docker

To run the application in a Docker container:

1.  Build the image:
    ```bash
    docker build -t outside-game .
    ```
2.  Run the container:
    ```bash
    docker run -p 777:777 outside-game
    ```

The application will be available at `http://localhost:777`.

## GitHub Container Registry

This repository now includes a GitHub Actions workflow that publishes a Docker image to GitHub Container Registry on every push to `main` and on version tags.

After the workflow has run successfully, you can pull the image directly:

```bash
docker pull ghcr.io/rubeldirubelda/outside-game:latest
docker run --rm -p 777:777 ghcr.io/rubeldirubelda/outside-game:latest
```

If you run the app behind Cloudflare, make sure WebSockets stay enabled and avoid caching the Socket.IO traffic path. That is usually the quickest way to keep button presses and round updates responsive.