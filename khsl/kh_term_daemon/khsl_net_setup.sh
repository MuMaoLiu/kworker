#!/system/bin/sh
# KHSL Network Setup Script
# This script is called by kh_term_daemon to setup veth and NAT

# 参数: $1 = 宿主机端网卡名 (e.g., veth_khsl), $2 = Ubuntu端网卡名 (e.g., veth_guest), $3 = Ubuntu 进程 PID
HOST_IF=$1
GUEST_IF=$2
GUEST_PID=$3

HOST_IP="172.18.0.1"
GUEST_IP="172.18.0.2"
SUBNET="172.18.0.0/24"

echo "[KHSL Net] Setting up network for PID $GUEST_PID..."

# 1. 创建 veth pair (由于 OH 自带的 ip 命令可能不支持 peer 语法，我们尝试多种方式)
# 尝试标准语法 (如果未来安装了完整的 iproute2)
ip link add $HOST_IF type veth peer name $GUEST_IF 2>/dev/null
if [ $? -ne 0 ]; then
    # 如果失败，说明 ip 命令残缺。
    # 作为备选方案，我们尝试直接在 C 代码中处理，或者假设系统环境已经准备好。
    # 这里为了演示，我们先打印错误，因为这需要完整的 ip 工具。
    echo "[KHSL Net] Error: 'ip link add' failed. OpenHarmony's ip tool is too limited."
    # 临时回退方案：如果不成功，我们就不做网络隔离，让 C 代码捕获错误。
    exit 1
fi

# 2. 启动宿主机端网卡并分配 IP
ip link set $HOST_IF up
ip addr add $HOST_IP/24 dev $HOST_IF

# 3. 将另一端移入 Guest 的 Network Namespace
ip link set $GUEST_IF netns $GUEST_PID

# 4. 配置 iptables NAT 转发 (允许 Ubuntu 访问外网)
# 开启内核 IP 转发
echo 1 > /proc/sys/net/ipv4/ip_forward
# 设置 NAT 伪装
iptables -t nat -A POSTROUTING -s $SUBNET ! -o $HOST_IF -j MASQUERADE
# 允许转发
iptables -A FORWARD -i $HOST_IF -j ACCEPT
iptables -A FORWARD -o $HOST_IF -j ACCEPT

echo "[KHSL Net] Host side network setup completed."
exit 0
