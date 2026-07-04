#!/usr/bin/env python
"""
Launcher script for Stem Separator Backend
Automatically detects and uses local virtual environment if available
Includes comprehensive dependency checking before launch
"""

import os
import sys
import subprocess
from pathlib import Path
import argparse


def check_critical_imports(python_exe):
    """Check if critical packages are available"""
    critical_packages = [
        ("fastapi", "FastAPI framework"),
        ("uvicorn", "ASGI server"),
        ("torch", "PyTorch"),
        ("torchaudio", "TorchAudio"),
        ("demucs", "Demucs (audio separation)"),
        ("torchcrepe", "TorchCrepe (F0 tracking)"),
        ("librosa", "LibROSA (audio analysis)"),
        ("soundfile", "SoundFile (audio I/O)"),
        ("numpy", "NumPy"),
        ("scipy", "SciPy")
    ]

    missing = []
    print("Checking critical dependencies...")

    for package, description in critical_packages:
        try:
            result = subprocess.run(
                [str(python_exe), "-c", f"import {package}"],
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                print(f"  [OK] {description} ({package})")
            else:
                print(f"  [MISSING] {description} ({package})")
                missing.append(package)
        except Exception as e:
            print(f"  [ERROR] {description} ({package}) - {e}")
            missing.append(package)

    return missing


def install_dependencies(python_exe, requirements_file):
    """Install dependencies from requirements.txt with smart conflict resolution"""
    print("\nInstalling dependencies...")
    print("This may take several minutes on first run...")

    try:
        # Upgrade pip first
        print("  Upgrading pip, setuptools, and wheel...")
        subprocess.run(
            [str(python_exe), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
            check=True,
            capture_output=True
        )

        # Try standard installation first
        print(f"  Installing from {requirements_file.name}...")
        result = subprocess.run(
            [str(python_exe), "-m", "pip", "install", "-r", str(requirements_file)],
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            # Check for dependency conflicts
            if "ResolutionImpossible" in result.stderr or "dependency conflict" in result.stderr.lower():
                print("  [WARNING] Detected dependency conflicts - using smart resolution...")
                return install_with_smart_resolution(python_exe, requirements_file)
            else:
                print(f"  [ERROR] Installation failed: {result.stderr}")
                return False

        print("  [SUCCESS] Dependencies installed successfully!")
        return True
    except subprocess.CalledProcessError as e:
        print(f"  [ERROR] Failed to install dependencies: {e}")
        return False


def install_with_smart_resolution(python_exe, requirements_file):
    """Install with smart conflict resolution for numpy/scipy issues"""
    print("  Using smart dependency resolution...")

    try:
        # Step 1: Install PyTorch first (dictates numpy/scipy versions)
        print("  Step 1/3: Installing PyTorch ecosystem...")
        subprocess.run(
            [str(python_exe), "-m", "pip", "install", "torch>=2.0.0", "torchaudio>=2.0.0"],
            check=True,
            capture_output=False
        )

        # Step 2: Install remaining packages with flexible numpy/scipy
        print("  Step 2/3: Installing remaining packages...")

        # Read and modify requirements
        with open(requirements_file, 'r') as f:
            lines = f.readlines()

        # Create temp requirements without pinned numpy/scipy
        backend_dir = Path(requirements_file).parent
        temp_reqs = backend_dir / "requirements_temp.txt"
        with open(temp_reqs, 'w') as f:
            for line in lines:
                line_stripped = line.strip()
                if line_stripped.startswith('numpy=='):
                    f.write('numpy>=1.24.0\n')
                elif line_stripped.startswith('scipy=='):
                    f.write('scipy>=1.10.0\n')
                elif line_stripped.startswith('torch') or line_stripped.startswith('# '):
                    continue  # Skip torch (already installed) and comments
                else:
                    f.write(line)

        # Install from temp file
        subprocess.run(
            [str(python_exe), "-m", "pip", "install", "-r", str(temp_reqs)],
            check=True,
            capture_output=False
        )

        # Clean up
        temp_reqs.unlink()

        # Step 3: Verify
        print("  Step 3/3: Verifying installation...")
        critical = ["torch", "torchaudio", "numpy", "scipy", "librosa", "fastapi", "demucs", "torchcrepe", "soundfile"]
        for pkg in critical:
            result = subprocess.run(
                [str(python_exe), "-c", f"import {pkg}"],
                capture_output=True
            )
            if result.returncode == 0:
                print(f"    [OK] {pkg}")
            else:
                print(f"    [FAILED] {pkg}")
                return False

        print("  [SUCCESS] Smart resolution successful!")
        return True

    except Exception as e:
        print(f"  [ERROR] Smart resolution failed: {e}")
        return False


def find_free_port(start_port=8000, max_attempts=10):
    """Find a free port starting from start_port"""
    import socket
    for port in range(start_port, start_port + max_attempts):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(('0.0.0.0', port))
            sock.close()
            return port
        except OSError:
            continue
    return None


def main():
    parser = argparse.ArgumentParser(description="Run Stem Separator Backend")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=None, help="Port to bind to (auto-finds free port if not specified)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    parser.add_argument("--workers", type=int, default=1, help="Number of worker processes")
    parser.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error", "critical"])
    args = parser.parse_args()

    # Find free port if not specified
    if args.port is None:
        args.port = find_free_port(8000)
        if args.port is None:
            print("[ERROR] Could not find a free port between 8000-8009")
            sys.exit(1)
        print(f"[INFO] Auto-selected free port: {args.port}")

    # Try to find a local virtual environment first
    backend_dir = Path(__file__).parent
    local_venv = backend_dir / ".venv"
    parent_venv = backend_dir.parent / ".venv"

    # Resolve python executable: check local venv, parent venv, or use current interpreter
    python_exe = None
    for venv_path in [local_venv, parent_venv]:
        if venv_path.exists():
            if sys.platform == "win32":
                candidate = venv_path / "Scripts" / "python.exe"
            else:
                candidate = venv_path / "bin" / "python"
            if candidate.exists():
                python_exe = candidate
                print(f"Found virtual environment at: {venv_path}")
                break

    if python_exe is None:
        print(f"No local virtual environment found. Using current interpreter.")
        python_exe = Path(sys.executable)
    
    # Change to backend directory
    backend_dir = Path(__file__).parent
    os.chdir(backend_dir)
    
    print(f"Starting Stem Separator Backend...")
    print(f"Using Python: {python_exe}")
    print(f"Host: {args.host}:{args.port}")
    print(f"Workers: {args.workers}")
    print(f"Log Level: {args.log_level}")
    
    # Comprehensive dependency check
    print("\n" + "="*60)
    print("DEPENDENCY CHECK".center(60))
    print("="*60)

    requirements_file = backend_dir / "requirements.txt"
    if not requirements_file.exists():
        print(f"[ERROR] requirements.txt not found at {requirements_file}")
        print("Cannot continue without requirements file.")
        sys.exit(1)

    # Check for missing packages
    missing = check_critical_imports(python_exe)

    if missing:
        print(f"\n[WARNING] Missing {len(missing)} critical package(s): {', '.join(missing)}")
        print("\nAuto-installing missing dependencies...")

        if not install_dependencies(python_exe, requirements_file):
            print("\n[ERROR] Dependency installation failed!")
            print("Please try manually running: pip install -r requirements.txt")
            sys.exit(1)

        # Re-check after installation
        missing_after = check_critical_imports(python_exe)
        if missing_after:
            print(f"\n[ERROR] Still missing packages after installation: {', '.join(missing_after)}")
            sys.exit(1)

    print("\n[SUCCESS] All critical dependencies satisfied!")

    # Write port to file for desktop app to read
    port_file = backend_dir / "backend_port.txt"
    with open(port_file, 'w') as f:
        f.write(str(args.port))
    print(f"[INFO] Backend port written to {port_file}")

    # Build uvicorn command
    cmd = [
        str(python_exe),
        "-m", "uvicorn",
        "main:app",
        "--host", args.host,
        "--port", str(args.port),
        "--log-level", args.log_level,
    ]
    
    if args.reload:
        cmd.append("--reload")
    
    if args.workers > 1 and not args.reload:
        cmd.extend(["--workers", str(args.workers)])
    
    print(f"\nRunning: {' '.join(cmd)}\n")
    print("=" * 50)
    print("API Documentation will be available at:")
    print(f"  http://localhost:{args.port}/docs")
    print(f"  http://localhost:{args.port}/redoc")
    print("=" * 50)
    print("\nPress Ctrl+C to stop the server\n")
    
    try:
        # Run the server
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\n\nServer stopped by user")
    except Exception as e:
        print(f"\nError running server: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
