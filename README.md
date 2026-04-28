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