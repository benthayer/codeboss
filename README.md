# codeboss

Vanity git commit hash miner. Makes your commits start with `c0deb055`.

## How It Works

1. You make a commit normally
2. Run `codeboss '<template>'` with a message template
3. The miner finds a message variation that produces a `c0deb055...` hash
4. Your commit is amended with the winning message

The miner runs on a 224-core GCP VM, achieving ~500M hashes/sec. Finding a match typically takes 2-10 seconds.

## Template Syntax

Templates use `{a|b|c}` for choices:

```
{fix|Fix}: {typo|spelling} in README
```

This expands to 4 variations:
- `fix: typo in README`
- `fix: spelling in README`
- `Fix: typo in README`
- `Fix: spelling in README`

### Features

- **N-ary choices**: `{a|b|c|d}` - any number of options
- **Optional elements**: `{|foo}` - includes empty string as option
- **Nesting**: `{fix {a|the} typo|typo fix}` - choices within choices

### Entropy Requirement

Templates must have at least **37 bits of entropy** (~137 billion variations). The miner will reject templates with insufficient entropy.

Example high-entropy template:
```
{fix|Fix|fixed|Fixed|docs|Docs|chore|Chore}: {|a |the }{typo|spelling|misspelling} in {README|docs|documentation}
```

## Local Setup

### 1. Build the miner

```bash
cd ~/projects/codeboss
cargo build --release
```

### 2. Add to PATH

```bash
chmod +x codeboss
ln -s ~/projects/codeboss/codeboss ~/.local/bin/codeboss
```

### 3. Ensure gcloud is configured

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT
```

## GCP VM Setup

### 1. Create the VM

```bash
gcloud compute instances create sha1-bench-224 \
  --zone=us-central1-a \
  --machine-type=n2d-standard-224 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB
```

### 2. Create service account with suspend permission

```bash
PROJECT=$(gcloud config get-value project)

# Create service account
gcloud iam service-accounts create codeboss-miner \
  --display-name="Codeboss Mining VM"

# Grant suspend permission
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:codeboss-miner@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1"
```

### 3. Attach service account to VM

```bash
# Must stop VM first
gcloud compute instances stop sha1-bench-224 --zone=us-central1-a

gcloud compute instances set-service-account sha1-bench-224 \
  --zone=us-central1-a \
  --service-account="codeboss-miner@$PROJECT.iam.gserviceaccount.com" \
  --scopes=compute-rw

gcloud compute instances start sha1-bench-224 --zone=us-central1-a
```

### 4. Install Rust and build miner on VM

```bash
gcloud compute ssh sha1-bench-224 --zone=us-central1-a

# On the VM:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

### 5. Deploy miner and scripts

```bash
# From local machine:
gcloud compute scp target/release/codeboss sha1-bench-224:~/codeboss --zone=us-central1-a
gcloud compute scp vm/run-codeboss sha1-bench-224:~/run-codeboss --zone=us-central1-a
gcloud compute scp vm/keepalive-check sha1-bench-224:~/keepalive-check --zone=us-central1-a

# On VM:
gcloud compute ssh sha1-bench-224 --zone=us-central1-a --command='
chmod +x ~/codeboss ~/run-codeboss
sudo cp ~/keepalive-check /usr/local/bin/keepalive-check
sudo chmod +x /usr/local/bin/keepalive-check
'
```

### 6. Set up auto-suspend cron

```bash
gcloud compute ssh sha1-bench-224 --zone=us-central1-a --command='
(sudo crontab -l 2>/dev/null | grep -v keepalive-check; echo "* * * * * /usr/local/bin/keepalive-check") | sudo crontab -
'
```

The VM will automatically suspend after 2.5 minutes of inactivity.

### 7. Suspend the VM when not in use

```bash
gcloud compute instances suspend sha1-bench-224 --zone=us-central1-a
```

## Usage

```bash
# Make a commit
git commit -m "fix typo"

# Amend with vanity hash
codeboss '{fix|Fix|fixed|Fixed|docs|Docs}: {|a |the }{typo|spelling|misspelling} in {README|docs}'
```

Output:
```
🎯 Target: c0deb055
📝 Template: {fix|Fix|fixed|Fixed|docs|Docs}: ...
🌳 Tree: abc123...
👆 Parent: def456...
👤 Author: Your Name <you@example.com>
⏰ Time: 1234567890 +0000

🔄 Resuming instance...
⏳ Waiting for SSH...
⛏️  Mining...

Template: 2147483648 variations (31.0 bits)
Target: c0deb055
Threads: 224

100 M attempts, 498 M/sec
200 M attempts, 502 M/sec

Found in 4.21s (2113000000 attempts, 502 M/sec)
Hash: c0deb055a1b2c3d4e5f6...

📝 Amending commit...
✅ Done!
   Hash: c0deb055a1b2c3d4e5f6...
   🎉 Vanity hash achieved!
```

## Cost

- VM: ~$7.50/hour when running (n2d-standard-224)
- Suspended: ~$1.50/day (disk + IP)
- Typical mining: 2-10 seconds = ~$0.01 per commit

The auto-suspend ensures you don't accidentally leave it running.

