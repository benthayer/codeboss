#!/bin/bash
# setup-instance.sh - Create and configure the mining VM
#
# Usage: ./setup-instance.sh
#
# Reads configuration from ../.env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env
if [[ -f "$PROJECT_ROOT/.env" ]]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

# Required env vars
: "${GCP_INSTANCE:?GCP_INSTANCE not set}"
: "${GCP_ZONE:?GCP_ZONE not set}"
: "${GCP_MACHINE_TYPE:?GCP_MACHINE_TYPE not set}"

# =============================================================================
# Instance Creation
# =============================================================================

create_instance() {
    echo "🚀 Creating instance $GCP_INSTANCE..."
    
    gcloud compute instances create "$GCP_INSTANCE" \
        --zone="$GCP_ZONE" \
        --machine-type="$GCP_MACHINE_TYPE" \
        --image-family=debian-12 \
        --image-project=debian-cloud \
        --boot-disk-size=20GB \
        --boot-disk-type=pd-ssd \
        --scopes=compute-rw \
        --quiet
    
    echo "⏳ Waiting for instance to be ready..."
    sleep 30
}

# =============================================================================
# Instance Setup
# =============================================================================

build_local() {
    echo "🔨 Building miner binary locally..."
    
    cd "$PROJECT_ROOT"
    cargo build --release
}

copy_files() {
    echo "📁 Copying files..."
    
    # Clean up any existing codeboss directory/file
    gcloud compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --command="rm -rf ~/codeboss"
    
    # Copy VM scripts
    gcloud compute scp "$SCRIPT_DIR/run-codeboss" "$GCP_INSTANCE:~/" --zone="$GCP_ZONE"
    gcloud compute scp "$SCRIPT_DIR/keepalive-check" "$GCP_INSTANCE:~/" --zone="$GCP_ZONE"
    
    # Copy compiled binary
    gcloud compute scp "$PROJECT_ROOT/target/release/codeboss" "$GCP_INSTANCE:~/codeboss" --zone="$GCP_ZONE"
}

setup_scripts() {
    echo "⚙️  Setting up scripts..."
    
    gcloud compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --command="
        chmod +x ~/run-codeboss ~/codeboss ~/keepalive-check
        
        # Install keepalive-check to system location
        sudo cp ~/keepalive-check /usr/local/bin/
        sudo chmod +x /usr/local/bin/keepalive-check
    "
}

setup_cron() {
    echo "⏰ Setting up cron..."
    
    gcloud compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --command="
        # Add cron job for keepalive check (every minute) - idempotent
        CRON_JOB='* * * * * /usr/local/bin/keepalive-check'
        (crontab -l 2>/dev/null | grep -v keepalive-check; echo \"\$CRON_JOB\") | crontab -
        
        echo 'Cron entries:'
        crontab -l
    "
}

suspend_instance() {
    echo "💤 Suspending instance for fast startup..."
    
    gcloud compute instances suspend "$GCP_INSTANCE" --zone="$GCP_ZONE" --quiet
}

# =============================================================================
# Main
# =============================================================================

echo "Setting up $GCP_INSTANCE in $GCP_ZONE"
echo "Machine type: $GCP_MACHINE_TYPE"
echo

# Build locally first
build_local

# Create instance if it doesn't exist
if gcloud compute instances describe "$GCP_INSTANCE" --zone="$GCP_ZONE" &>/dev/null; then
    echo "✓ Instance already exists"
    
    # Resume if suspended so we can SSH
    STATUS=$(gcloud compute instances describe "$GCP_INSTANCE" --zone="$GCP_ZONE" --format='get(status)')
    if [[ "$STATUS" == "SUSPENDED" ]]; then
        echo "🔄 Resuming instance for setup..."
        gcloud compute instances resume "$GCP_INSTANCE" --zone="$GCP_ZONE" --quiet
        sleep 15
    elif [[ "$STATUS" == "TERMINATED" || "$STATUS" == "STOPPED" ]]; then
        echo "🚀 Starting instance for setup..."
        gcloud compute instances start "$GCP_INSTANCE" --zone="$GCP_ZONE" --quiet
        sleep 15
    fi
else
    create_instance
fi

copy_files
setup_scripts
setup_cron

echo
echo "✅ Setup complete!"
echo "   Instance: $GCP_INSTANCE"
echo "   Zone: $GCP_ZONE"
echo
echo "   To suspend: gcloud compute instances suspend $GCP_INSTANCE --zone=$GCP_ZONE"

